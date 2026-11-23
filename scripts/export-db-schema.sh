#!/usr/bin/env bash
#
# export-db-schema.sh
#
# 只读导出 huya-danmu 项目的 PostgreSQL 数据库结构（schema-only）。
#
# 设计要点：
#   * 通过 `docker exec` 在 PostgreSQL 容器内部运行官方 pg_dump，
#     不开放端口、不在宿主机读取或暴露数据库密码。
#   * 只导出结构，不导出业务数据（--schema-only）。
#   * 先写入临时文件，校验通过后再原子替换正式 schema.sql。
#   * 导出失败 / 校验失败时，保留已有的有效 schema.sql。
#
# 用法：
#   ./scripts/export-db-schema.sh
#
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="${COMPOSE_FILE:-$PROJECT_ROOT/compose.yaml}"
OUTPUT_DIR="$PROJECT_ROOT/database-schema"
OUTPUT_FILE="$OUTPUT_DIR/schema.sql"
INFO_FILE="$OUTPUT_DIR/export-info.txt"

TMPFILE=""
ERRFILE=""
cleanup() {
  if [[ -n "$TMPFILE" && -f "$TMPFILE" ]]; then rm -f "$TMPFILE"; fi
  if [[ -n "$ERRFILE" && -f "$ERRFILE" ]]; then rm -f "$ERRFILE"; fi
  return 0
}
trap cleanup EXIT

fail() {
  echo "ERROR: $*" >&2
  echo "Existing schema.sql (if any) was left unchanged." >&2
  exit 1
}

command -v docker >/dev/null 2>&1 || fail "docker not found on PATH."

[[ -f "$COMPOSE_FILE" ]] || fail "compose file not found: $COMPOSE_FILE"

# ---------------------------------------------------------------------------
# 1) 定位本项目 compose 中的 postgres 容器
# ---------------------------------------------------------------------------
CONTAINER_ID="$(docker compose -f "$COMPOSE_FILE" ps -q postgres 2>/dev/null | head -n1 || true)"
if [[ -z "$CONTAINER_ID" ]]; then
  PROJECT_NAME="$(basename "$PROJECT_ROOT")"
  CONTAINER_ID="$(docker ps \
    --filter "label=com.docker.compose.project=$PROJECT_NAME" \
    --filter "label=com.docker.compose.service=postgres" \
    --format '{{.ID}}' | head -n1 || true)"
fi
[[ -n "$CONTAINER_ID" ]] || fail "cannot locate the postgres container for this project."

# ---------------------------------------------------------------------------
# 2) 只读取容器环境里的 DB 名称与用户（绝不读取/打印密码）
# ---------------------------------------------------------------------------
container_env() {
  docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$CONTAINER_ID" \
    | grep -E "^$1=" | head -n1 | cut -d= -f2-
}

DB_USER="$(container_env POSTGRES_USER || true)"
DB_NAME="$(container_env POSTGRES_DB || true)"
[[ -n "$DB_USER" ]] || fail "cannot determine POSTGRES_USER from container $CONTAINER_ID."
[[ -n "$DB_NAME" ]] || fail "cannot determine POSTGRES_DB from container $CONTAINER_ID."

# ---------------------------------------------------------------------------
# 3) 检测业务 schema（排除 pg_* / information_schema 等系统对象）
# ---------------------------------------------------------------------------
SCHEMA_QUERY="SELECT nspname FROM pg_namespace WHERE nspname <> 'information_schema' AND nspname !~ '^pg_' ORDER BY 1;"
SCHEMAS_RAW="$(docker exec "$CONTAINER_ID" psql -U "$DB_USER" -d "$DB_NAME" -Atc "$SCHEMA_QUERY" 2>/dev/null || true)"
[[ -n "$SCHEMAS_RAW" ]] || fail "no non-system schemas found in database $DB_NAME."

SCHEMA_LIST=""
DUMP_ARGS=(--schema-only --no-owner --no-privileges --no-tablespaces -U "$DB_USER" -d "$DB_NAME")
while IFS= read -r schema; do
  [[ -z "$schema" ]] && continue
  DUMP_ARGS+=(-n "$schema")
  if [[ -z "$SCHEMA_LIST" ]]; then
    SCHEMA_LIST="$schema"
  else
    SCHEMA_LIST="$SCHEMA_LIST, $schema"
  fi
done <<< "$SCHEMAS_RAW"

[[ -n "$SCHEMA_LIST" ]] || fail "schema list is empty."

# ---------------------------------------------------------------------------
# 4) 导出到临时文件（容器内部 pg_dump，输出重定向到宿主机临时文件）
# ---------------------------------------------------------------------------
mkdir -p "$OUTPUT_DIR"
TMPFILE="$(mktemp "$OUTPUT_DIR/.schema.sql.tmp.XXXXXX")"
ERRFILE="$(mktemp "$OUTPUT_DIR/.schema.sql.err.XXXXXX")"

echo "==> Container: $CONTAINER_ID"
echo "==> Database : $DB_NAME"
echo "==> Schemas  : $SCHEMA_LIST"
echo "==> Running pg_dump (schema-only) ..."

if ! docker exec "$CONTAINER_ID" pg_dump "${DUMP_ARGS[@]}" > "$TMPFILE" 2> "$ERRFILE"; then
  echo "ERROR: pg_dump failed:" >&2
  cat "$ERRFILE" >&2
  fail "pg_dump exited with a non-zero status."
fi
[[ -s "$ERRFILE" ]] && { echo "WARNING: pg_dump wrote to stderr:" >&2; cat "$ERRFILE" >&2; }
rm -f "$ERRFILE"
ERRFILE=""

# ---------------------------------------------------------------------------
# 5) 校验：非空 + 含 DDL + 无数据 + 无敏感信息
# ---------------------------------------------------------------------------
[[ -s "$TMPFILE" ]] || fail "pg_dump produced an empty file."

if ! grep -Eq 'CREATE[[:space:]]+(TABLE|SEQUENCE|TYPE|FUNCTION|PROCEDURE|TRIGGER|VIEW|MATERIALIZED VIEW)' "$TMPFILE"; then
  fail "dump does not contain any CREATE TABLE/SEQUENCE/TYPE/... DDL; not a usable schema dump."
fi

# 5.1 禁止 INSERT INTO（业务数据）
if grep -Eqi '^[[:space:]]*INSERT[[:space:]]+INTO' "$TMPFILE"; then
  echo "ERROR: data export detected (INSERT INTO):" >&2
  grep -Eni '^[[:space:]]*INSERT[[:space:]]+INTO' "$TMPFILE" >&2
  fail "refusing to replace schema.sql because the dump appears to contain data."
fi

# 5.2 禁止 COPY ... FROM stdin（业务数据）
if grep -Eqi '^[[:space:]]*COPY[[:space:]]+.*FROM[[:space:]]+stdin' "$TMPFILE"; then
  echo "ERROR: data export detected (COPY ... FROM stdin):" >&2
  grep -Eni '^[[:space:]]*COPY[[:space:]]+.*FROM[[:space:]]+stdin' "$TMPFILE" >&2
  fail "refusing to replace schema.sql because the dump appears to contain data."
fi

# 5.3 敏感信息扫描
#     - 连接字符串 / 环境变量赋值：直接判定失败
#     - 普通关键字：仅当“独立成词”时判定失败；
#       password_hash / reset_token 这类字段名（关键字紧邻 _ 或字母数字）视为正常。
if grep -Eqi 'postgres(ql)?://[^[:space:]"'"'"']+' "$TMPFILE"; then
  echo "ERROR: connection string detected in schema dump:" >&2
  grep -Eni 'postgres(ql)?://[^[:space:]"'"'"']+' "$TMPFILE" >&2
  fail "refusing to replace schema.sql: possible connection string leak."
fi

if grep -Eqi '(^|[^A-Za-z0-9_])(API_KEY|DATABASE_URL)[[:space:]]*[=:]' "$TMPFILE"; then
  echo "ERROR: API_KEY / DATABASE_URL assignment detected in schema dump:" >&2
  grep -Eni '(^|[^A-Za-z0-9_])(API_KEY|DATABASE_URL)[[:space:]]*[=:]' "$TMPFILE" >&2
  fail "refusing to replace schema.sql: possible secret/env-var leak."
fi

STANDALONE_KEYWORDS='(^|[^A-Za-z0-9_])(PASSWORD|PASSWD|SECRET|TOKEN)([^A-Za-z0-9_]|$)'
if grep -Eqi "$STANDALONE_KEYWORDS" "$TMPFILE"; then
  echo "ERROR: standalone sensitive keyword detected (PASSWORD/SECRET/TOKEN):" >&2
  grep -Eni "$STANDALONE_KEYWORDS" "$TMPFILE" >&2
  fail "refusing to replace schema.sql: possible hard-coded secret."
fi

# ---------------------------------------------------------------------------
# 6) 原子替换正式文件，并更新 export-info.txt
# ---------------------------------------------------------------------------
mv -f "$TMPFILE" "$OUTPUT_FILE"
TMPFILE=""

PG_VERSION="$(docker exec "$CONTAINER_ID" psql -U "$DB_USER" -d "$DB_NAME" -Atc 'SHOW server_version;' 2>/dev/null || true)"
[[ -z "$PG_VERSION" ]] && PG_VERSION="unknown"

SCHEMA_SIZE_BYTES="$(wc -c < "$OUTPUT_FILE" | tr -d ' ')"
if git -C "$PROJECT_ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  GIT_COMMIT="$(git -C "$PROJECT_ROOT" rev-parse HEAD 2>/dev/null || echo N/A)"
else
  GIT_COMMIT="N/A"
fi

{
  echo "Export Time: $(date '+%Y-%m-%d %H:%M:%S %Z')"
  echo "PostgreSQL Version: $PG_VERSION"
  echo "Database: $DB_NAME"
  echo "Schemas: $SCHEMA_LIST"
  echo "Schema File: database-schema/schema.sql"
  echo "Schema File Size: $SCHEMA_SIZE_BYTES bytes"
  echo "Git Commit: $GIT_COMMIT"
} > "$INFO_FILE"

echo "==> Done."
echo "    Schema file : $OUTPUT_FILE"
echo "    Size        : $SCHEMA_SIZE_BYTES bytes"
echo "    Info file   : $INFO_FILE"

-- 一次性运维脚本：把历史「按月」弹幕分区转换为「按天」分区
--
-- 背景：应用改为按天分区 + 只保留 HOT_RETENTION_DAYS 天（默认 30），
--       过期整日分区直接 DROP 才能立即归还磁盘。
--       旧部署留下的是 danmu_messages_2026_11 这类月分区，需要一次性转换。
--
-- 为什么不在 migrations/ 里：涉及数据搬迁，不应在应用启动时自动执行。
--
-- 用法：
--   PGOPTIONS='-c ops.part_filter=%_10' psql -v ON_ERROR_STOP=1 -f migration/003_daily_message_partitions.sql
--   PGOPTIONS='-c ops.part_filter=%_11' psql -v ON_ERROR_STOP=1 -f migration/003_daily_message_partitions.sql
--   （ops.part_filter 缺省 '%'，即转换全部月分区）
--
-- 每个月分区在一个事务内完成：DETACH -> 按天建分区 -> 搬数据 -> DROP 月分区。
-- 中途失败会整体回滚，可重复执行（已是独立表的月分区会被识别并继续处理）。

DO $$
DECLARE
  part_filter text := coalesce(current_setting('ops.part_filter', true), '%');
  part_name text;
  day_start timestamptz;
  day_end timestamptz;
  day_table text;
  moved bigint;
  total bigint := 0;
  attached boolean;
BEGIN
  PERFORM set_config('TimeZone', 'UTC', true);

  FOR part_name IN
    SELECT c.relname
    FROM pg_class c
    WHERE c.relkind = 'r'
      AND c.relnamespace = 'public'::regnamespace
      AND c.relname LIKE 'danmu_messages\_%'
      AND c.relname ~ '^danmu_messages_[0-9]{4}_[0-9]{2}$'
      AND c.relname LIKE part_filter
    ORDER BY c.relname
  LOOP
    attached := EXISTS (
      SELECT 1
      FROM pg_inherits i
      JOIN pg_class p ON p.oid = i.inhparent
      JOIN pg_class ch ON ch.oid = i.inhrelid
      WHERE p.relname = 'danmu_messages' AND ch.relname = part_name
    );

    IF attached THEN
      RAISE NOTICE 'detach %', part_name;
      EXECUTE format('ALTER TABLE danmu_messages DETACH PARTITION %I', part_name);
    ELSE
      RAISE NOTICE 'detach 跳过 %（已是独立表）', part_name;
    END IF;

    FOR day_start IN EXECUTE format(
      $q$SELECT generate_series(date_trunc('day', min(occurred_at)),
                                date_trunc('day', max(occurred_at)),
                                interval '1 day') FROM %I$q$, part_name)
    LOOP
      day_end := day_start + interval '1 day';
      day_table := 'danmu_messages_' || to_char(day_start, 'YYYY_MM_DD');

      EXECUTE format(
        'CREATE TABLE IF NOT EXISTS %I PARTITION OF danmu_messages FOR VALUES FROM (%L) TO (%L)',
        day_table, day_start, day_end);
      -- 与 ensureMessagePartition 保持相同的二级索引
      EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I (room_id, occurred_at DESC)',
        day_table || '_room_time_idx', day_table);
      EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I (room_id, sender_uid, occurred_at DESC)',
        day_table || '_sender_time_idx', day_table);

      EXECUTE format('INSERT INTO %I SELECT * FROM %I WHERE occurred_at >= %L AND occurred_at < %L',
        day_table, part_name, day_start, day_end);
      GET DIAGNOSTICS moved = ROW_COUNT;
      total := total + moved;
      RAISE NOTICE '  % -> % : % rows', part_name, day_table, moved;
    END LOOP;

    EXECUTE format('DROP TABLE %I', part_name);
    RAISE NOTICE '转换完成 %', part_name;
  END LOOP;

  RAISE NOTICE '共搬迁 % 行', total;
END $$;

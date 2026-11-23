\set ON_ERROR_STOP on
BEGIN;

-- 1) rooms: import only external_room_ids that don't already exist (active)
INSERT INTO public.rooms (
  id, external_room_id, anchor_uid, anchor_name, enabled, runtime_status,
  last_checked_at, last_message_at, last_error, metadata, created_at, updated_at, deleted_at)
SELECT o.id, o.external_room_id, o.anchor_uid, o.anchor_name, o.enabled, o.runtime_status,
       o.last_checked_at, o.last_message_at, o.last_error, o.metadata, o.created_at, o.updated_at, o.deleted_at
FROM old_imp.rooms o
WHERE NOT EXISTS (
  SELECT 1 FROM public.rooms n
  WHERE n.external_room_id = o.external_room_id AND n.deleted_at IS NULL
)
ON CONFLICT DO NOTHING;

-- 2) sessions: remap legacy 116864 room id -> new room id; convert the old active session to completed
INSERT INTO public.live_sessions (
  id, room_id, detected_started_at, detected_ended_at,
  platform_started_at, platform_ended_at, status, metadata, created_at, updated_at)
SELECT s.id,
       CASE WHEN s.room_id = '140950a8-97a0-4703-b27e-b6ede9dd5868'::uuid
            THEN '85010801-0f37-47a5-805f-bd78000d509a'::uuid ELSE s.room_id END,
       s.detected_started_at,
       CASE WHEN s.status = 'active'
            THEN (SELECT detected_started_at FROM public.live_sessions
                  WHERE room_id = '85010801-0f37-47a5-805f-bd78000d509a'::uuid AND status = 'active')
            ELSE s.detected_ended_at END,
       s.platform_started_at, s.platform_ended_at,
       CASE WHEN s.status = 'active' THEN 'completed' ELSE s.status END,
       s.metadata, s.created_at, s.updated_at
FROM old_imp.live_sessions s
WHERE s.room_id IN (SELECT id FROM public.rooms)
   OR s.room_id = '140950a8-97a0-4703-b27e-b6ede9dd5868'::uuid
ON CONFLICT (id) DO NOTHING;

-- 3) messages: only before the cut-off T (new listener's earliest message), remap room id
INSERT INTO public.danmu_messages (
  ingest_id, room_id, session_id, source_event_id, occurred_at, received_at, time_source,
  sender_uid, sender_name, content, content_normalized, content_hash, raw_payload)
SELECT m.ingest_id,
       CASE WHEN m.room_id = '140950a8-97a0-4703-b27e-b6ede9dd5868'::uuid
            THEN '85010801-0f37-47a5-805f-bd78000d509a'::uuid ELSE m.room_id END,
       m.session_id, m.source_event_id, m.occurred_at, m.received_at, m.time_source,
       m.sender_uid, m.sender_name, m.content, m.content_normalized, m.content_hash, m.raw_payload
FROM old_imp.danmu_messages m
WHERE m.occurred_at < TIMESTAMPTZ '2026-09-15 01:15:23.756+08'
  AND (m.room_id IN (SELECT id FROM public.rooms)
       OR m.room_id = '140950a8-97a0-4703-b27e-b6ede9dd5868'::uuid)
ON CONFLICT (ingest_id, occurred_at) DO NOTHING;

-- 4) room_status_history for the live room only, remapped
INSERT INTO public.room_status_history (
  id, room_id, from_status, to_status, reason, source, details, created_at)
SELECT h.id, '85010801-0f37-47a5-805f-bd78000d509a'::uuid,
       h.from_status, h.to_status, h.reason, h.source, h.details, h.created_at
FROM old_imp.room_status_history h
WHERE h.room_id = '140950a8-97a0-4703-b27e-b6ede9dd5868'::uuid
ON CONFLICT (id) DO NOTHING;

COMMIT;

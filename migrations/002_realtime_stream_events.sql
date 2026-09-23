ALTER TABLE stream_events
  DROP CONSTRAINT IF EXISTS stream_events_event_type_check;

ALTER TABLE stream_events
  ADD CONSTRAINT stream_events_event_type_check
  CHECK (event_type IN ('gift', 'online', 'paid_message_snapshot'));

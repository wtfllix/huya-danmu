# Realtime SSE interoperability

## Protocol mapping

The V1 listener keeps the three upstream message families separate:

- URI `1400` -> `chat`
- URI `6501` -> `gift`
- URI `2001314` -> `paid_message_snapshot`

For URI `6501`, every gift is persisted. Only gifts with at least 100 Huya
coins are published to the realtime SSE stream:

```text
total_huya_coin = lPayTotal / 100
gift threshold = 100 Huya coins
```

`lPayTotal` is read as an int64 string before the conversion. The verified
10-Huya-coin horn sample (`iItemType=22177`, `lPayTotal="1000"`) is persisted
but is not published to SSE. No business meaning is inferred between the
6501 gift and 2001314 events.

For URI `2001314`, the paid-message text comes from `item.sContent` and is
normalized to `items[].content`. A paid snapshot represents current paid
message state, not an append-only event list.

## Event shape

`paid_message_snapshot` keeps the SSE event name and also identifies itself in
the JSON data payload:

```text
event: paid_message_snapshot
data: {"event_type":"paid_message_snapshot","items":[]}
```

Chat and gift events also keep their `event_type` in the JSON payload. Clients
may therefore use either the SSE event name or `data.event_type`.

## Resume and reset

Clients reconnect with `Last-Event-ID`.

- If the ID is still in the room ring buffer, the server replays later events.
- If the ID is no longer available, the server sends `reset` first and then
  the current `paid_message_snapshot`, when one exists.
- `reset` means the incremental event chain cannot be replayed completely.
  The following snapshot restores current paid-message state; it is not
  historical replay.

The fixed recovery order is:

```text
event: reset
event: paid_message_snapshot
```

## Known limitations

- The ring buffer is process-memory only.
- Paid-message state during listener downtime depends on database warm restore
  and eventual upstream correction.
- Rare URI `1400` EOF/DataView failures remain unresolved. A future failure
  with complete frame metadata must be used to distinguish frame slicing,
  payload extraction, and payload corruption.
- SSE buffering through an external reverse proxy still requires deployment-
  environment verification.

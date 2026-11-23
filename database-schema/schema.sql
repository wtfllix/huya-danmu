--
-- PostgreSQL database dump
--

\restrict fZSMmYd5opReYDWQyF2ggZvdrf6SZcJXBvAMbZHOnW5nVxdE2WmUu2fPCIzhWn8

-- Dumped from database version 17.11
-- Dumped by pg_dump version 17.11

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA public;


--
-- Name: SCHEMA public; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON SCHEMA public IS 'standard public schema';


SET default_table_access_method = heap;

--
-- Name: archive_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.archive_runs (
    id uuid NOT NULL,
    started_at timestamp with time zone NOT NULL,
    finished_at timestamp with time zone,
    range_start timestamp with time zone NOT NULL,
    range_end timestamp with time zone NOT NULL,
    path text,
    bytes_written bigint,
    row_count bigint,
    checksum character(64),
    backup_status text DEFAULT 'pending'::text NOT NULL,
    status text NOT NULL,
    error text
);


--
-- Name: collector_incidents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.collector_incidents (
    id uuid NOT NULL,
    room_id uuid NOT NULL,
    session_id uuid,
    started_at timestamp with time zone NOT NULL,
    ended_at timestamp with time zone,
    type text NOT NULL,
    details jsonb DEFAULT '{}'::jsonb NOT NULL
);


--
-- Name: danmu_daily_content_counts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.danmu_daily_content_counts (
    room_id uuid NOT NULL,
    local_date date NOT NULL,
    content_hash character(64) NOT NULL,
    content_normalized text NOT NULL,
    representative_content text NOT NULL,
    message_count bigint DEFAULT 0 NOT NULL
);


--
-- Name: danmu_daily_stats; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.danmu_daily_stats (
    room_id uuid NOT NULL,
    local_date date NOT NULL,
    message_count bigint DEFAULT 0 NOT NULL
);


--
-- Name: danmu_daily_top_messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.danmu_daily_top_messages (
    room_id uuid NOT NULL,
    local_date date NOT NULL,
    rank integer NOT NULL,
    content_hash character(64) NOT NULL,
    content_normalized text NOT NULL,
    representative_content text NOT NULL,
    message_count bigint NOT NULL,
    share double precision NOT NULL
);


--
-- Name: danmu_messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.danmu_messages (
    ingest_id uuid NOT NULL,
    room_id uuid NOT NULL,
    session_id uuid,
    source_event_id text,
    occurred_at timestamp with time zone NOT NULL,
    received_at timestamp with time zone NOT NULL,
    time_source text NOT NULL,
    sender_uid text,
    sender_name text DEFAULT ''::text NOT NULL,
    content text NOT NULL,
    content_normalized text NOT NULL,
    content_hash character(64) NOT NULL,
    raw_payload jsonb,
    CONSTRAINT danmu_messages_time_source_check CHECK ((time_source = ANY (ARRAY['source'::text, 'received'::text])))
)
PARTITION BY RANGE (occurred_at);


--
-- Name: danmu_messages_2026_09; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.danmu_messages_2026_09 (
    ingest_id uuid NOT NULL,
    room_id uuid NOT NULL,
    session_id uuid,
    source_event_id text,
    occurred_at timestamp with time zone NOT NULL,
    received_at timestamp with time zone NOT NULL,
    time_source text NOT NULL,
    sender_uid text,
    sender_name text DEFAULT ''::text NOT NULL,
    content text NOT NULL,
    content_normalized text NOT NULL,
    content_hash character(64) NOT NULL,
    raw_payload jsonb,
    CONSTRAINT danmu_messages_time_source_check CHECK ((time_source = ANY (ARRAY['source'::text, 'received'::text])))
);


--
-- Name: danmu_minute_stats; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.danmu_minute_stats (
    room_id uuid NOT NULL,
    bucket_at timestamp with time zone NOT NULL,
    message_count bigint DEFAULT 0 NOT NULL
);


--
-- Name: live_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.live_sessions (
    id uuid NOT NULL,
    room_id uuid NOT NULL,
    detected_started_at timestamp with time zone NOT NULL,
    detected_ended_at timestamp with time zone,
    platform_started_at timestamp with time zone,
    platform_ended_at timestamp with time zone,
    status text NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT live_sessions_status_check CHECK ((status = ANY (ARRAY['active'::text, 'completed'::text, 'interrupted'::text])))
);


--
-- Name: room_status_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.room_status_history (
    id bigint NOT NULL,
    room_id uuid NOT NULL,
    from_status text,
    to_status text NOT NULL,
    reason text,
    source text,
    details jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: room_status_history_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.room_status_history_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: room_status_history_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.room_status_history_id_seq OWNED BY public.room_status_history.id;


--
-- Name: rooms; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.rooms (
    id uuid NOT NULL,
    external_room_id text NOT NULL,
    anchor_uid text,
    anchor_name text,
    enabled boolean DEFAULT true NOT NULL,
    runtime_status text DEFAULT 'unknown'::text NOT NULL,
    last_checked_at timestamp with time zone,
    last_message_at timestamp with time zone,
    last_error jsonb,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    CONSTRAINT rooms_runtime_status_check CHECK ((runtime_status = ANY (ARRAY['disabled'::text, 'unknown'::text, 'offline'::text, 'starting'::text, 'listening'::text, 'degraded'::text, 'stopping'::text])))
);


--
-- Name: schema_migrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.schema_migrations (
    version text NOT NULL,
    applied_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: storage_snapshots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.storage_snapshots (
    id bigint NOT NULL,
    target text NOT NULL,
    sampled_at timestamp with time zone DEFAULT now() NOT NULL,
    total_bytes bigint,
    used_bytes bigint,
    available_bytes bigint,
    category_sizes jsonb DEFAULT '{}'::jsonb NOT NULL,
    status text NOT NULL,
    error text
);


--
-- Name: storage_snapshots_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.storage_snapshots_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: storage_snapshots_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.storage_snapshots_id_seq OWNED BY public.storage_snapshots.id;


--
-- Name: stream_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.stream_events (
    ingest_id uuid NOT NULL,
    room_id uuid NOT NULL,
    session_id uuid,
    event_type text NOT NULL,
    occurred_at timestamp with time zone NOT NULL,
    received_at timestamp with time zone NOT NULL,
    payload jsonb NOT NULL,
    CONSTRAINT stream_events_event_type_check CHECK ((event_type = ANY (ARRAY['gift'::text, 'online'::text])))
);


--
-- Name: danmu_messages_2026_09; Type: TABLE ATTACH; Schema: public; Owner: -
--

ALTER TABLE ONLY public.danmu_messages ATTACH PARTITION public.danmu_messages_2026_09 FOR VALUES FROM ('2026-09-01 08:00:00+08') TO ('2026-10-01 08:00:00+08');


--
-- Name: room_status_history id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_status_history ALTER COLUMN id SET DEFAULT nextval('public.room_status_history_id_seq'::regclass);


--
-- Name: storage_snapshots id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.storage_snapshots ALTER COLUMN id SET DEFAULT nextval('public.storage_snapshots_id_seq'::regclass);


--
-- Name: archive_runs archive_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.archive_runs
    ADD CONSTRAINT archive_runs_pkey PRIMARY KEY (id);


--
-- Name: collector_incidents collector_incidents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.collector_incidents
    ADD CONSTRAINT collector_incidents_pkey PRIMARY KEY (id);


--
-- Name: danmu_daily_content_counts danmu_daily_content_counts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.danmu_daily_content_counts
    ADD CONSTRAINT danmu_daily_content_counts_pkey PRIMARY KEY (room_id, local_date, content_hash);


--
-- Name: danmu_daily_stats danmu_daily_stats_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.danmu_daily_stats
    ADD CONSTRAINT danmu_daily_stats_pkey PRIMARY KEY (room_id, local_date);


--
-- Name: danmu_daily_top_messages danmu_daily_top_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.danmu_daily_top_messages
    ADD CONSTRAINT danmu_daily_top_messages_pkey PRIMARY KEY (room_id, local_date, rank);


--
-- Name: danmu_messages danmu_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.danmu_messages
    ADD CONSTRAINT danmu_messages_pkey PRIMARY KEY (ingest_id, occurred_at);


--
-- Name: danmu_messages_2026_09 danmu_messages_2026_09_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.danmu_messages_2026_09
    ADD CONSTRAINT danmu_messages_2026_09_pkey PRIMARY KEY (ingest_id, occurred_at);


--
-- Name: danmu_minute_stats danmu_minute_stats_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.danmu_minute_stats
    ADD CONSTRAINT danmu_minute_stats_pkey PRIMARY KEY (room_id, bucket_at);


--
-- Name: live_sessions live_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.live_sessions
    ADD CONSTRAINT live_sessions_pkey PRIMARY KEY (id);


--
-- Name: room_status_history room_status_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_status_history
    ADD CONSTRAINT room_status_history_pkey PRIMARY KEY (id);


--
-- Name: rooms rooms_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rooms
    ADD CONSTRAINT rooms_pkey PRIMARY KEY (id);


--
-- Name: schema_migrations schema_migrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schema_migrations
    ADD CONSTRAINT schema_migrations_pkey PRIMARY KEY (version);


--
-- Name: storage_snapshots storage_snapshots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.storage_snapshots
    ADD CONSTRAINT storage_snapshots_pkey PRIMARY KEY (id);


--
-- Name: stream_events stream_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stream_events
    ADD CONSTRAINT stream_events_pkey PRIMARY KEY (ingest_id);


--
-- Name: collector_incidents_room_started_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX collector_incidents_room_started_idx ON public.collector_incidents USING btree (room_id, started_at DESC);


--
-- Name: danmu_daily_content_rank_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX danmu_daily_content_rank_idx ON public.danmu_daily_content_counts USING btree (room_id, local_date, message_count DESC);


--
-- Name: danmu_messages_2026_09_room_time_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX danmu_messages_2026_09_room_time_idx ON public.danmu_messages_2026_09 USING btree (room_id, occurred_at DESC);


--
-- Name: danmu_messages_2026_09_sender_time_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX danmu_messages_2026_09_sender_time_idx ON public.danmu_messages_2026_09 USING btree (room_id, sender_uid, occurred_at DESC);


--
-- Name: live_sessions_one_active_per_room; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX live_sessions_one_active_per_room ON public.live_sessions USING btree (room_id) WHERE (status = 'active'::text);


--
-- Name: live_sessions_room_started_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX live_sessions_room_started_idx ON public.live_sessions USING btree (room_id, detected_started_at DESC);


--
-- Name: room_status_history_room_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX room_status_history_room_created_idx ON public.room_status_history USING btree (room_id, created_at DESC);


--
-- Name: rooms_external_room_id_active_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX rooms_external_room_id_active_key ON public.rooms USING btree (external_room_id) WHERE (deleted_at IS NULL);


--
-- Name: storage_snapshots_target_sampled_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX storage_snapshots_target_sampled_idx ON public.storage_snapshots USING btree (target, sampled_at DESC);


--
-- Name: stream_events_room_time_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX stream_events_room_time_idx ON public.stream_events USING btree (room_id, occurred_at DESC);


--
-- Name: danmu_messages_2026_09_pkey; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.danmu_messages_pkey ATTACH PARTITION public.danmu_messages_2026_09_pkey;


--
-- Name: collector_incidents collector_incidents_room_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.collector_incidents
    ADD CONSTRAINT collector_incidents_room_id_fkey FOREIGN KEY (room_id) REFERENCES public.rooms(id);


--
-- Name: collector_incidents collector_incidents_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.collector_incidents
    ADD CONSTRAINT collector_incidents_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.live_sessions(id);


--
-- Name: danmu_daily_content_counts danmu_daily_content_counts_room_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.danmu_daily_content_counts
    ADD CONSTRAINT danmu_daily_content_counts_room_id_fkey FOREIGN KEY (room_id) REFERENCES public.rooms(id);


--
-- Name: danmu_daily_stats danmu_daily_stats_room_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.danmu_daily_stats
    ADD CONSTRAINT danmu_daily_stats_room_id_fkey FOREIGN KEY (room_id) REFERENCES public.rooms(id);


--
-- Name: danmu_daily_top_messages danmu_daily_top_messages_room_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.danmu_daily_top_messages
    ADD CONSTRAINT danmu_daily_top_messages_room_id_fkey FOREIGN KEY (room_id) REFERENCES public.rooms(id);


--
-- Name: danmu_messages danmu_messages_room_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE public.danmu_messages
    ADD CONSTRAINT danmu_messages_room_id_fkey FOREIGN KEY (room_id) REFERENCES public.rooms(id);


--
-- Name: danmu_messages danmu_messages_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE public.danmu_messages
    ADD CONSTRAINT danmu_messages_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.live_sessions(id);


--
-- Name: danmu_minute_stats danmu_minute_stats_room_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.danmu_minute_stats
    ADD CONSTRAINT danmu_minute_stats_room_id_fkey FOREIGN KEY (room_id) REFERENCES public.rooms(id);


--
-- Name: live_sessions live_sessions_room_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.live_sessions
    ADD CONSTRAINT live_sessions_room_id_fkey FOREIGN KEY (room_id) REFERENCES public.rooms(id);


--
-- Name: room_status_history room_status_history_room_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_status_history
    ADD CONSTRAINT room_status_history_room_id_fkey FOREIGN KEY (room_id) REFERENCES public.rooms(id);


--
-- Name: stream_events stream_events_room_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stream_events
    ADD CONSTRAINT stream_events_room_id_fkey FOREIGN KEY (room_id) REFERENCES public.rooms(id);


--
-- Name: stream_events stream_events_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stream_events
    ADD CONSTRAINT stream_events_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.live_sessions(id);


--
-- PostgreSQL database dump complete
--

\unrestrict fZSMmYd5opReYDWQyF2ggZvdrf6SZcJXBvAMbZHOnW5nVxdE2WmUu2fPCIzhWn8


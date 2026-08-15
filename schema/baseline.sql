TABLE app_user
  COL   1 username               text                           NOT NULL
  COL   2 sub                    text                          
  COL   3 name                   text                          
  COL   4 email                  text                          
  COL   5 is_super               boolean                        NOT NULL DEFAULT false
  COL   6 created_at             timestamp with time zone       NOT NULL DEFAULT now()
  COL   7 last_login             timestamp with time zone      
  CON app_user_pkey                      PRIMARY KEY (username)
TABLE audit_log
  COL   1 id                     bigint                         NOT NULL DEFAULT nextval('audit_log_id_seq'::regclass)
  COL   2 ts                     timestamp with time zone       NOT NULL DEFAULT now()
  COL   3 actor                  text                           NOT NULL
  COL   4 action                 text                           NOT NULL
  COL   5 target                 text                           NOT NULL DEFAULT ''::text
  COL   6 detail                 text                           NOT NULL DEFAULT ''::text
  CON audit_log_pkey                     PRIMARY KEY (id)
  IDX CREATE INDEX idx_audit_log_ts ON public.audit_log USING btree (ts)
SEQ audit_log_id_seq
TABLE item_versions
  COL   1 id                     bigint                         NOT NULL DEFAULT nextval('item_versions_id_seq'::regclass)
  COL   2 item_id                bigint                         NOT NULL
  COL   3 s3_key                 text                           NOT NULL
  COL   4 size                   bigint                        
  COL   5 sha256                 text                          
  COL   6 label                  text                          
  COL   7 created_by             text                           NOT NULL
  COL   8 created_at             timestamp with time zone       NOT NULL DEFAULT now()
  CON item_versions_item_id_fkey         FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE CASCADE
  CON item_versions_pkey                 PRIMARY KEY (id)
  IDX CREATE INDEX idx_item_versions_item ON public.item_versions USING btree (item_id)
SEQ item_versions_id_seq
TABLE items
  COL   1 id                     bigint                         NOT NULL DEFAULT nextval('items_id_seq'::regclass)
  COL   2 project_id             bigint                         NOT NULL
  COL   3 parent_id              bigint                        
  COL   4 kind                   text                           NOT NULL
  COL   5 name                   text                           NOT NULL
  COL   6 s3_key                 text                          
  COL   7 size                   bigint                        
  COL   8 mime                   text                          
  COL   9 sha256                 text                          
  COL  10 sha_verified           boolean                        NOT NULL DEFAULT false
  COL  11 created_by             text                           NOT NULL
  COL  12 created_at             timestamp with time zone       NOT NULL DEFAULT now()
  COL  13 updated_at             timestamp with time zone       NOT NULL DEFAULT now()
  COL  14 upload_fp              text                          
  COL  15 upload_id              text                          
  COL  16 upload_key             text                          
  COL  17 meeting_id             bigint                        
  COL  18 is_recording           boolean                        NOT NULL DEFAULT false
  COL  19 deleted_at             timestamp with time zone      
  COL  20 deleted_by             text                          
  CON items_kind_check                   CHECK ((kind = ANY (ARRAY['folder'::text, 'doc'::text, 'file'::text, 'video'::text])))
  CON items_meeting_id_fkey              FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE SET NULL
  CON items_parent_id_fkey               FOREIGN KEY (parent_id) REFERENCES items(id) ON DELETE CASCADE
  CON items_pkey                         PRIMARY KEY (id)
  CON items_project_id_fkey              FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
  IDX CREATE INDEX idx_items_live ON public.items USING btree (project_id, parent_id) WHERE (deleted_at IS NULL)
  IDX CREATE INDEX idx_items_meeting ON public.items USING btree (meeting_id) WHERE (meeting_id IS NOT NULL)
  IDX CREATE INDEX idx_items_resume ON public.items USING btree (project_id, created_by, upload_fp) WHERE (s3_key IS NULL)
  IDX CREATE INDEX idx_items_s3key ON public.items USING btree (s3_key) WHERE (s3_key IS NOT NULL)
  IDX CREATE INDEX idx_items_sha ON public.items USING btree (sha256) WHERE ((sha256 IS NOT NULL) AND (deleted_at IS NULL))
  IDX CREATE INDEX idx_items_trash ON public.items USING btree (project_id, deleted_at DESC) WHERE (deleted_at IS NOT NULL)
SEQ items_id_seq
TABLE media_jobs
  COL   1 id                     bigint                         NOT NULL DEFAULT nextval('media_jobs_id_seq'::regclass)
  COL   2 item_id                bigint                         NOT NULL
  COL   3 status                 text                           NOT NULL DEFAULT 'queued'::text
  COL   4 stage                  text                           NOT NULL DEFAULT ''::text
  COL   5 progress               integer                        NOT NULL DEFAULT 0
  COL   6 error                  text                          
  COL   7 requested_by           text                           NOT NULL
  COL   8 created_at             timestamp with time zone       NOT NULL DEFAULT now()
  COL   9 updated_at             timestamp with time zone       NOT NULL DEFAULT now()
  CON media_jobs_item_id_fkey            FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE CASCADE
  CON media_jobs_pkey                    PRIMARY KEY (id)
  CON media_jobs_status_check            CHECK ((status = ANY (ARRAY['queued'::text, 'running'::text, 'done'::text, 'failed'::text])))
  IDX CREATE UNIQUE INDEX idx_media_jobs_active ON public.media_jobs USING btree (item_id) WHERE (status = ANY (ARRAY['queued'::text, 'running'::text]))
SEQ media_jobs_id_seq
TABLE meeting_link_history
  COL   1 id                     bigint                         NOT NULL DEFAULT nextval('meeting_link_history_id_seq'::regclass)
  COL   2 meeting_id             bigint                         NOT NULL
  COL   3 old_url                text                           NOT NULL DEFAULT ''::text
  COL   4 new_url                text                           NOT NULL DEFAULT ''::text
  COL   5 changed_by             text                           NOT NULL
  COL   6 changed_at             timestamp with time zone       NOT NULL DEFAULT now()
  CON meeting_link_history_meeting_id_fk FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
  CON meeting_link_history_pkey          PRIMARY KEY (id)
  IDX CREATE INDEX idx_mlh_meeting ON public.meeting_link_history USING btree (meeting_id, changed_at DESC)
SEQ meeting_link_history_id_seq
TABLE meeting_messages
  COL   1 id                     bigint                         NOT NULL DEFAULT nextval('meeting_messages_id_seq'::regclass)
  COL   2 meeting_id             bigint                         NOT NULL
  COL   3 sender                 text                           NOT NULL
  COL   4 channel                text                           NOT NULL
  COL   5 peer                   text                          
  COL   6 body                   text                           NOT NULL
  COL   7 created_at             timestamp with time zone       NOT NULL DEFAULT now()
  CON meeting_messages_channel_check     CHECK ((channel = ANY (ARRAY['public'::text, 'private'::text])))
  CON meeting_messages_check             CHECK (((channel = 'public'::text) OR (peer IS NOT NULL)))
  CON meeting_messages_meeting_id_fkey   FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
  CON meeting_messages_pkey              PRIMARY KEY (id)
  IDX CREATE INDEX idx_mm_meeting ON public.meeting_messages USING btree (meeting_id, created_at)
SEQ meeting_messages_id_seq
TABLE meeting_minutes
  COL   1 meeting_id             bigint                         NOT NULL
  COL   2 status                 text                           NOT NULL DEFAULT 'draft'::text
  COL   3 attendees              text                           NOT NULL DEFAULT ''::text
  COL   4 observers              text                           NOT NULL DEFAULT ''::text
  COL   5 absentees              text                           NOT NULL DEFAULT ''::text
  COL   6 agenda_text            text                           NOT NULL DEFAULT ''::text
  COL   7 content_md             text                           NOT NULL DEFAULT ''::text
  COL   8 resolutions            text                           NOT NULL DEFAULT ''::text
  COL   9 todos                  text                           NOT NULL DEFAULT ''::text
  COL  10 pdf_item_id            bigint                        
  COL  11 completed_at           timestamp with time zone      
  COL  12 updated_at             timestamp with time zone       NOT NULL DEFAULT now()
  CON meeting_minutes_meeting_id_fkey    FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
  CON meeting_minutes_pdf_item_id_fkey   FOREIGN KEY (pdf_item_id) REFERENCES items(id) ON DELETE SET NULL
  CON meeting_minutes_pkey               PRIMARY KEY (meeting_id)
  CON meeting_minutes_status_check       CHECK ((status = ANY (ARRAY['draft'::text, 'done'::text])))
TABLE meeting_participants
  COL   1 meeting_id             bigint                         NOT NULL
  COL   2 username               text                           NOT NULL
  COL   3 kind                   text                           NOT NULL DEFAULT 'attendee'::text
  COL   4 status                 text                           NOT NULL DEFAULT 'pending'::text
  COL   5 counter_starts_at      timestamp with time zone      
  COL   6 counter_ends_at        timestamp with time zone      
  COL   7 counter_reason         text                          
  COL   8 responded_at           timestamp with time zone      
  COL   9 invited_at             timestamp with time zone       NOT NULL DEFAULT now()
  COL  10 required               boolean                        NOT NULL DEFAULT true
  CON meeting_participants_kind_check    CHECK ((kind = ANY (ARRAY['attendee'::text, 'observer'::text])))
  CON meeting_participants_meeting_id_fk FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
  CON meeting_participants_pkey          PRIMARY KEY (meeting_id, username)
  CON meeting_participants_status_check  CHECK ((status = ANY (ARRAY['pending'::text, 'accepted'::text, 'declined'::text, 'tentative'::text, 'counter'::text])))
  IDX CREATE INDEX idx_mp_user ON public.meeting_participants USING btree (username)
TABLE meeting_projects
  COL   1 meeting_id             bigint                         NOT NULL
  COL   2 project_id             bigint                         NOT NULL
  CON meeting_projects_meeting_id_fkey   FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
  CON meeting_projects_pkey              PRIMARY KEY (meeting_id, project_id)
  CON meeting_projects_project_id_fkey   FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
  IDX CREATE INDEX idx_mpj_project ON public.meeting_projects USING btree (project_id)
TABLE meeting_reads
  COL   1 meeting_id             bigint                         NOT NULL
  COL   2 username               text                           NOT NULL
  COL   3 read_at                timestamp with time zone       NOT NULL DEFAULT now()
  CON meeting_reads_meeting_id_fkey      FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
  CON meeting_reads_pkey                 PRIMARY KEY (meeting_id, username)
  IDX CREATE INDEX idx_mr_user ON public.meeting_reads USING btree (username)
TABLE meetings
  COL   1 id                     bigint                         NOT NULL DEFAULT nextval('meetings_id_seq'::regclass)
  COL   2 title                  text                           NOT NULL
  COL   3 agenda                 text                           NOT NULL DEFAULT ''::text
  COL   4 organizer              text                           NOT NULL
  COL   5 recorder               text                           NOT NULL
  COL   6 starts_at              timestamp with time zone       NOT NULL
  COL   7 ends_at                timestamp with time zone       NOT NULL
  COL   8 timezone               text                           NOT NULL DEFAULT 'Asia/Shanghai'::text
  COL   9 location               text                           NOT NULL DEFAULT ''::text
  COL  10 online_url             text                           NOT NULL DEFAULT ''::text
  COL  11 visibility             text                           NOT NULL DEFAULT 'private'::text
  COL  12 status                 text                           NOT NULL DEFAULT 'active'::text
  COL  13 rrule                  text                          
  COL  14 created_at             timestamp with time zone       NOT NULL DEFAULT now()
  COL  15 updated_at             timestamp with time zone       NOT NULL DEFAULT now()
  COL  16 actual_minutes         integer                       
  COL  17 actual_by              text                          
  COL  18 no_download            boolean                        NOT NULL DEFAULT false
  COL  19 no_share               boolean                        NOT NULL DEFAULT false
  CON meetings_actual_minutes_check      CHECK (((actual_minutes IS NULL) OR ((actual_minutes > 0) AND (actual_minutes <= (24 * 60)))))
  CON meetings_check                     CHECK ((ends_at > starts_at))
  CON meetings_pkey                      PRIMARY KEY (id)
  CON meetings_status_check              CHECK ((status = ANY (ARRAY['active'::text, 'canceled'::text])))
  CON meetings_visibility_check          CHECK ((visibility = ANY (ARRAY['private'::text, 'public'::text])))
  IDX CREATE INDEX idx_meetings_organizer ON public.meetings USING btree (organizer, starts_at DESC)
  IDX CREATE INDEX idx_meetings_time ON public.meetings USING btree (starts_at, ends_at) WHERE (status = 'active'::text)
SEQ meetings_id_seq
TABLE owner_transfers
  COL   1 id                     bigint                         NOT NULL DEFAULT nextval('owner_transfers_id_seq'::regclass)
  COL   2 project_id             bigint                         NOT NULL
  COL   3 from_user              text                           NOT NULL
  COL   4 to_user                text                           NOT NULL
  COL   5 status                 text                           NOT NULL DEFAULT 'pending'::text
  COL   6 created_at             timestamp with time zone       NOT NULL DEFAULT now()
  COL   7 settled_at             timestamp with time zone      
  CON owner_transfers_pkey               PRIMARY KEY (id)
  CON owner_transfers_project_id_fkey    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
  CON owner_transfers_status_check       CHECK ((status = ANY (ARRAY['pending'::text, 'accepted'::text, 'declined'::text, 'canceled'::text])))
  IDX CREATE INDEX idx_ot_to ON public.owner_transfers USING btree (to_user) WHERE (status = 'pending'::text)
  IDX CREATE UNIQUE INDEX idx_ot_one_pending ON public.owner_transfers USING btree (project_id) WHERE (status = 'pending'::text)
SEQ owner_transfers_id_seq
TABLE play_progress
  COL   1 username               text                           NOT NULL
  COL   2 item_id                bigint                         NOT NULL
  COL   3 position_sec           double precision               NOT NULL DEFAULT 0
  COL   4 duration_sec           double precision              
  COL   5 updated_at             timestamp with time zone       NOT NULL DEFAULT now()
  CON play_progress_item_id_fkey         FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE CASCADE
  CON play_progress_pkey                 PRIMARY KEY (username, item_id)
TABLE project_members
  COL   1 project_id             bigint                         NOT NULL
  COL   2 username               text                           NOT NULL
  COL   3 role                   text                           NOT NULL
  COL   4 added_by               text                           NOT NULL
  COL   5 added_at               timestamp with time zone       NOT NULL DEFAULT now()
  CON project_members_pkey               PRIMARY KEY (project_id, username)
  CON project_members_project_id_fkey    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
  CON project_members_role_check         CHECK ((role = ANY (ARRAY['viewer'::text, 'editor'::text, 'admin'::text])))
  IDX CREATE INDEX idx_pm_user ON public.project_members USING btree (username)
TABLE projects
  COL   1 id                     bigint                         NOT NULL DEFAULT nextval('projects_id_seq'::regclass)
  COL   2 name                   text                           NOT NULL
  COL   3 description            text                           NOT NULL DEFAULT ''::text
  COL   4 visibility             text                           NOT NULL DEFAULT 'public'::text
  COL   5 owner                  text                           NOT NULL
  COL   6 created_by             text                           NOT NULL
  COL   7 created_at             timestamp with time zone       NOT NULL DEFAULT now()
  COL   8 quota_bytes            bigint                         NOT NULL DEFAULT '10737418240'::bigint
  COL   9 no_download            boolean                        NOT NULL DEFAULT false
  COL  10 no_share               boolean                        NOT NULL DEFAULT false
  COL  11 hotwords               text                           NOT NULL DEFAULT ''::text
  COL  12 deleted_at             timestamp with time zone      
  COL  13 deleted_by             text                          
  COL  14 archived_at            timestamp with time zone      
  COL  15 archived_by            text                          
  CON projects_pkey                      PRIMARY KEY (id)
  CON projects_visibility_check          CHECK ((visibility = ANY (ARRAY['public'::text, 'private'::text])))
  IDX CREATE INDEX idx_projects_active ON public.projects USING btree (id) WHERE ((archived_at IS NULL) AND (deleted_at IS NULL))
  IDX CREATE INDEX idx_projects_owner ON public.projects USING btree (owner)
SEQ projects_id_seq
TABLE share_items
  COL   1 token                  text                           NOT NULL
  COL   2 item_id                bigint                         NOT NULL
  CON share_items_item_id_fkey           FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE CASCADE
  CON share_items_pkey                   PRIMARY KEY (token, item_id)
  CON share_items_token_fkey             FOREIGN KEY (token) REFERENCES share_links(token) ON DELETE CASCADE
TABLE share_links
  COL   1 token                  text                           NOT NULL
  COL   2 item_id                bigint                         NOT NULL
  COL   3 code_salt              text                          
  COL   4 code_hash              text                          
  COL   5 expires_at             timestamp with time zone      
  COL   6 max_visits             integer                       
  COL   7 visits                 integer                        NOT NULL DEFAULT 0
  COL   8 allow_download         boolean                        NOT NULL DEFAULT true
  COL   9 created_by             text                           NOT NULL
  COL  10 created_at             timestamp with time zone       NOT NULL DEFAULT now()
  COL  11 revoked_at             timestamp with time zone      
  COL  12 last_visit_at          timestamp with time zone      
  CON share_links_item_id_fkey           FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE CASCADE
  CON share_links_pkey                   PRIMARY KEY (token)
  IDX CREATE INDEX idx_share_links_creator ON public.share_links USING btree (created_by, created_at DESC)
  IDX CREATE INDEX idx_share_links_item ON public.share_links USING btree (item_id)
TABLE share_visits
  COL   1 id                     bigint                         NOT NULL DEFAULT nextval('share_visits_id_seq'::regclass)
  COL   2 token                  text                           NOT NULL
  COL   3 at                     timestamp with time zone       NOT NULL DEFAULT now()
  COL   4 ip_prefix              text                          
  COL   5 ua_hash                text                          
  COL   6 ok                     boolean                        NOT NULL DEFAULT true
  CON share_visits_pkey                  PRIMARY KEY (id)
  CON share_visits_token_fkey            FOREIGN KEY (token) REFERENCES share_links(token) ON DELETE CASCADE
  IDX CREATE INDEX idx_share_visits_fail ON public.share_visits USING btree (token, at DESC) WHERE (NOT ok)
  IDX CREATE INDEX idx_share_visits_token ON public.share_visits USING btree (token, at DESC)
SEQ share_visits_id_seq
TABLE summaries
  COL   1 item_id                bigint                         NOT NULL
  COL   2 kind                   text                           NOT NULL
  COL   3 content                text                           NOT NULL
  COL   4 model                  text                          
  COL   5 created_at             timestamp with time zone       NOT NULL DEFAULT now()
  CON summaries_item_id_fkey             FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE CASCADE
  CON summaries_kind_check               CHECK ((kind = ANY (ARRAY['brief'::text, 'outline'::text, 'decisions'::text])))
  CON summaries_pkey                     PRIMARY KEY (item_id, kind)
TABLE transcripts
  COL   1 item_id                bigint                         NOT NULL
  COL   2 text                   text                           NOT NULL
  COL   3 segments               jsonb                         
  COL   4 model                  text                          
  COL   5 duration_sec           double precision              
  COL   6 created_at             timestamp with time zone       NOT NULL DEFAULT now()
  COL   7 char_ts                jsonb                         
  COL   8 fine                   jsonb                         
  CON transcripts_item_id_fkey           FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE CASCADE
  CON transcripts_pkey                   PRIMARY KEY (item_id)

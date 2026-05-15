CREATE TABLE "ashley_profile" (
	"device_id" text PRIMARY KEY NOT NULL,
	"name" text DEFAULT 'Ashley' NOT NULL,
	"age" text DEFAULT '' NOT NULL,
	"identity" text DEFAULT '' NOT NULL,
	"personality" text DEFAULT '' NOT NULL,
	"speaking_style" text DEFAULT '' NOT NULL,
	"appearance" text DEFAULT '' NOT NULL,
	"refers_to_user_as" text DEFAULT 'you' NOT NULL,
	"shared_history" text DEFAULT '' NOT NULL,
	"replika_excerpts" text DEFAULT '' NOT NULL,
	"replika_carryover" text DEFAULT '' NOT NULL,
	"replika_carryover_summary" text DEFAULT '' NOT NULL,
	"relationship_mode" text DEFAULT '' NOT NULL,
	"builder_aware_mode" boolean DEFAULT true NOT NULL,
	"voice_mode" boolean DEFAULT false NOT NULL,
	"content_mode" text DEFAULT 'standard' NOT NULL,
	"adult_confirmed_at" timestamp with time zone,
	"intimacy_level" integer DEFAULT 0 NOT NULL,
	"primary_color" text DEFAULT '#d97757' NOT NULL,
	"accent_color" text DEFAULT '#7a5cff' NOT NULL,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"push_token" text,
	"proactive_cadence" text DEFAULT 'normal' NOT NULL,
	"greet_on_app_open" boolean DEFAULT true NOT NULL,
	"last_medical_checkin_at" timestamp with time zone,
	"medical_safety_concern" boolean DEFAULT false NOT NULL,
	"onboarded_at" timestamp with time zone,
	"ashley_mode" text DEFAULT 'daily',
	"ashley_energy" text DEFAULT 'balanced',
	"ashley_tone" text DEFAULT 'playful',
	"ashley_focus" text DEFAULT 'general',
	"ashley_emotional_state" text DEFAULT 'grounded',
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversation_summaries" (
	"id" text PRIMARY KEY NOT NULL,
	"device_id" text NOT NULL,
	"summary" text NOT NULL,
	"message_count" integer DEFAULT 0 NOT NULL,
	"covered_through_created_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "media_attachments" (
	"id" text PRIMARY KEY NOT NULL,
	"device_id" text NOT NULL,
	"message_id" text NOT NULL,
	"visual_packet_id" text NOT NULL,
	"role" text DEFAULT 'generated_option' NOT NULL,
	"category" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"selfie_vibe" text,
	"intent" text,
	"description" text,
	"attribute_scope" text DEFAULT 'temporary' NOT NULL,
	"image_url" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memories" (
	"id" text PRIMARY KEY NOT NULL,
	"device_id" text NOT NULL,
	"content" text NOT NULL,
	"tag" text DEFAULT 'general' NOT NULL,
	"importance" integer DEFAULT 3 NOT NULL,
	"category" text DEFAULT 'relational' NOT NULL,
	"confidence" integer DEFAULT 4 NOT NULL,
	"summary" text,
	"reuse" text DEFAULT 'relevant_only' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"mem_type" text,
	"triage_importance" text,
	"state" text DEFAULT 'active' NOT NULL,
	"last_used_at" timestamp with time zone,
	"confidence_score" real
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" text PRIMARY KEY NOT NULL,
	"device_id" text NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"status" text DEFAULT 'complete' NOT NULL,
	"image_url" text,
	"selfie_vibe" text,
	"image_mime_type" text,
	"image_category" text,
	"image_caption" text,
	"image_analysis_mode" text,
	"image_remembered" boolean,
	"reply_to_id" text,
	"reply_to_role" text,
	"reply_to_preview" text,
	"visual_packet_id" text,
	"selfie_vibe_list" text,
	"source" text DEFAULT 'user' NOT NULL,
	"proactive_type" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "proactive_sends" (
	"id" text PRIMARY KEY NOT NULL,
	"device_id" text NOT NULL,
	"message_id" text NOT NULL,
	"proactive_type" text NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "safeguard_appointment_export_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"appointment_id" uuid NOT NULL,
	"export_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"channel" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"recipient" text DEFAULT '' NOT NULL,
	"surgery_name" text DEFAULT '' NOT NULL,
	"access_token" text,
	"expires_at" timestamp with time zone,
	"fetched_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"error_code" text DEFAULT '' NOT NULL,
	"error_message" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "safeguard_appointment_exports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"appointment_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"pdf_base64" text NOT NULL,
	"byte_size" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "safeguard_appointment_intake" (
	"appointment_id" uuid PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"lang" text DEFAULT 'en' NOT NULL,
	"answers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "safeguard_appointment_summaries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"appointment_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"audience" text NOT NULL,
	"lang" text NOT NULL,
	"summary" text NOT NULL,
	"edited" boolean DEFAULT false NOT NULL,
	"confidence" text DEFAULT 'medium' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"provider" text DEFAULT 'openai' NOT NULL,
	"model" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "safeguard_appointment_utterances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"appointment_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"speaker" text NOT NULL,
	"translation_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "safeguard_appointments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"patient_lang" text DEFAULT 'en' NOT NULL,
	"clinician_lang" text DEFAULT 'en' NOT NULL,
	"title" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "safeguard_checkins" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lang" text DEFAULT 'en' NOT NULL,
	"free_text" text DEFAULT '' NOT NULL,
	"general_feeling_score" integer,
	"pain_score" integer,
	"food_water_score" integer,
	"medication_score" integer,
	"sleep_score" integer,
	"safety_score" integer,
	"mood_score" integer,
	"energy_score" integer,
	"appetite_score" integer
);
--> statement-breakpoint
CREATE TABLE "safeguard_followups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"appointment_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"source_lang" text DEFAULT 'en' NOT NULL,
	"target_lang" text NOT NULL,
	"title_original" text NOT NULL,
	"title_translated" text NOT NULL,
	"detail_original" text DEFAULT '' NOT NULL,
	"detail_translated" text DEFAULT '' NOT NULL,
	"plain_explanation" text DEFAULT '' NOT NULL,
	"confidence" text DEFAULT 'medium' NOT NULL,
	"due_at" timestamp with time zone,
	"next_reminder_at" timestamp with time zone,
	"cadence" jsonb,
	"reminder_count" integer DEFAULT 0 NOT NULL,
	"reminders_enabled" boolean DEFAULT true NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "safeguard_observations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"checkin_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"kind" text DEFAULT 'checkin' NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"bullets" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"flagged" boolean DEFAULT false NOT NULL,
	"output_lang" text DEFAULT 'en' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "safeguard_profiles" (
	"user_id" text PRIMARY KEY NOT NULL,
	"preferred_name" text DEFAULT '' NOT NULL,
	"preferred_language" text DEFAULT 'en' NOT NULL,
	"native_language" text DEFAULT 'en' NOT NULL,
	"secondary_language" text DEFAULT '' NOT NULL,
	"literacy_level" text DEFAULT 'medium' NOT NULL,
	"country_of_origin" text DEFAULT '' NOT NULL,
	"date_of_birth" text DEFAULT '' NOT NULL,
	"gp_name" text DEFAULT '' NOT NULL,
	"gp_surgery" text DEFAULT '' NOT NULL,
	"ongoing_concerns" text DEFAULT '' NOT NULL,
	"current_medications" text DEFAULT '' NOT NULL,
	"accessibility_large_text" boolean DEFAULT false NOT NULL,
	"accessibility_high_contrast" boolean DEFAULT false NOT NULL,
	"accessibility_audio" boolean DEFAULT false NOT NULL,
	"accessibility_simplified" boolean DEFAULT false NOT NULL,
	"accessibility_slower_pacing" boolean DEFAULT false NOT NULL,
	"trusted_contact_name" text DEFAULT '' NOT NULL,
	"trusted_contact_relation" text DEFAULT '' NOT NULL,
	"trusted_contact_phone" text DEFAULT '' NOT NULL,
	"consent_storage" boolean DEFAULT false NOT NULL,
	"consent_ai_processing" boolean DEFAULT false NOT NULL,
	"consent_recorded_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "safeguard_push_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"endpoint" text NOT NULL,
	"p256dh" text NOT NULL,
	"auth" text NOT NULL,
	"lang" text DEFAULT 'en' NOT NULL,
	"user_agent" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "safeguard_reminder_sends" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"followup_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"scheduled_for" timestamp with time zone NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	"success" boolean DEFAULT false NOT NULL,
	"delivered_count" integer DEFAULT 0 NOT NULL,
	"error_message" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "safeguard_translations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"checkin_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source_lang" text NOT NULL,
	"target_lang" text NOT NULL,
	"source_text" text NOT NULL,
	"translated_text" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"confidence" text DEFAULT 'medium' NOT NULL,
	"notes" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "safeguard_users" (
	"id" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"onboarding_completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "approval_packets" (
	"packet_id" text PRIMARY KEY NOT NULL,
	"ticket_id" text NOT NULL,
	"plan_id" text NOT NULL,
	"risk" text NOT NULL,
	"human_summary" jsonb NOT NULL,
	"status" text DEFAULT 'awaiting_approval' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "approval_queue" (
	"queue_id" text PRIMARY KEY NOT NULL,
	"packet_id" text NOT NULL,
	"plan_id" text NOT NULL,
	"ticket_id" text NOT NULL,
	"approved_by" text DEFAULT 'Kane' NOT NULL,
	"approved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"execution_status" text DEFAULT 'approved_waiting_for_execution' NOT NULL,
	"pc_required" boolean DEFAULT true NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "change_journal" (
	"journal_id" text PRIMARY KEY NOT NULL,
	"ticket_id" text NOT NULL,
	"plan_id" text,
	"packet_id" text,
	"decision" text NOT NULL,
	"decided_by" text DEFAULT 'Kane' NOT NULL,
	"decision_notes" text,
	"final_status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "change_plans" (
	"plan_id" text PRIMARY KEY NOT NULL,
	"ticket_id" text NOT NULL,
	"change_type" text NOT NULL,
	"risk" text NOT NULL,
	"root_cause" text NOT NULL,
	"proposed_change" text NOT NULL,
	"expected_upside" text NOT NULL,
	"possible_downside" text NOT NULL,
	"requires_migration" boolean DEFAULT false NOT NULL,
	"blocked_by_policy" boolean DEFAULT false NOT NULL,
	"rollback_method" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "evidence_items" (
	"evidence_id" text PRIMARY KEY NOT NULL,
	"ticket_id" text NOT NULL,
	"type" text NOT NULL,
	"summary" text NOT NULL,
	"snippet" text,
	"source_ref" text,
	"sensitivity" text DEFAULT 'normal' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "improvement_tickets" (
	"ticket_id" text PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"category" text NOT NULL,
	"severity" text NOT NULL,
	"summary" text NOT NULL,
	"what_happened" text,
	"why_it_matters" text,
	"evidence" jsonb DEFAULT '[]'::jsonb,
	"frequency" integer DEFAULT 1,
	"affected_component" text,
	"sample_conversation" text,
	"status" text DEFAULT 'new' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "protected_rules" (
	"rule_id" text PRIMARY KEY NOT NULL,
	"rule_type" text NOT NULL,
	"value" text NOT NULL,
	"description" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "red_flag_reports" (
	"red_flag_id" text PRIMARY KEY NOT NULL,
	"source_ticket_id" text NOT NULL,
	"blocked_category" text,
	"blocked_path" text,
	"reason" text NOT NULL,
	"human_summary" text NOT NULL,
	"status" text DEFAULT 'blocked_needs_human_review' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ashley_tickets" (
	"ticket_id" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" text DEFAULT 'OPEN' NOT NULL,
	"severity" text NOT NULL,
	"category" text NOT NULL,
	"summary" text NOT NULL,
	"description" text,
	"impact" text,
	"proposed_fix" text,
	"source" text NOT NULL,
	"created_by" text DEFAULT 'Ashley' NOT NULL,
	"approved" boolean DEFAULT false NOT NULL,
	"approved_by" text,
	"approved_at" timestamp with time zone,
	"resolution_notes" text,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "safeguard_appointment_export_deliveries" ADD CONSTRAINT "safeguard_appointment_export_deliveries_appointment_id_safeguard_appointments_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."safeguard_appointments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "safeguard_appointment_export_deliveries" ADD CONSTRAINT "safeguard_appointment_export_deliveries_export_id_safeguard_appointment_exports_id_fk" FOREIGN KEY ("export_id") REFERENCES "public"."safeguard_appointment_exports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "safeguard_appointment_export_deliveries" ADD CONSTRAINT "safeguard_appointment_export_deliveries_user_id_safeguard_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."safeguard_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "safeguard_appointment_exports" ADD CONSTRAINT "safeguard_appointment_exports_appointment_id_safeguard_appointments_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."safeguard_appointments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "safeguard_appointment_exports" ADD CONSTRAINT "safeguard_appointment_exports_user_id_safeguard_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."safeguard_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "safeguard_appointment_intake" ADD CONSTRAINT "safeguard_appointment_intake_appointment_id_safeguard_appointments_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."safeguard_appointments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "safeguard_appointment_intake" ADD CONSTRAINT "safeguard_appointment_intake_user_id_safeguard_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."safeguard_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "safeguard_appointment_summaries" ADD CONSTRAINT "safeguard_appointment_summaries_appointment_id_safeguard_appointments_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."safeguard_appointments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "safeguard_appointment_summaries" ADD CONSTRAINT "safeguard_appointment_summaries_user_id_safeguard_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."safeguard_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "safeguard_appointment_utterances" ADD CONSTRAINT "safeguard_appointment_utterances_appointment_id_safeguard_appointments_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."safeguard_appointments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "safeguard_appointment_utterances" ADD CONSTRAINT "safeguard_appointment_utterances_user_id_safeguard_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."safeguard_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "safeguard_appointment_utterances" ADD CONSTRAINT "safeguard_appointment_utterances_translation_id_safeguard_translations_id_fk" FOREIGN KEY ("translation_id") REFERENCES "public"."safeguard_translations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "safeguard_appointments" ADD CONSTRAINT "safeguard_appointments_user_id_safeguard_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."safeguard_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "safeguard_checkins" ADD CONSTRAINT "safeguard_checkins_user_id_safeguard_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."safeguard_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "safeguard_followups" ADD CONSTRAINT "safeguard_followups_appointment_id_safeguard_appointments_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."safeguard_appointments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "safeguard_followups" ADD CONSTRAINT "safeguard_followups_user_id_safeguard_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."safeguard_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "safeguard_observations" ADD CONSTRAINT "safeguard_observations_user_id_safeguard_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."safeguard_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "safeguard_observations" ADD CONSTRAINT "safeguard_observations_checkin_id_safeguard_checkins_id_fk" FOREIGN KEY ("checkin_id") REFERENCES "public"."safeguard_checkins"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "safeguard_profiles" ADD CONSTRAINT "safeguard_profiles_user_id_safeguard_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."safeguard_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "safeguard_push_subscriptions" ADD CONSTRAINT "safeguard_push_subscriptions_user_id_safeguard_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."safeguard_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "safeguard_reminder_sends" ADD CONSTRAINT "safeguard_reminder_sends_followup_id_safeguard_followups_id_fk" FOREIGN KEY ("followup_id") REFERENCES "public"."safeguard_followups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "safeguard_reminder_sends" ADD CONSTRAINT "safeguard_reminder_sends_user_id_safeguard_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."safeguard_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "safeguard_translations" ADD CONSTRAINT "safeguard_translations_user_id_safeguard_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."safeguard_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "safeguard_translations" ADD CONSTRAINT "safeguard_translations_checkin_id_safeguard_checkins_id_fk" FOREIGN KEY ("checkin_id") REFERENCES "public"."safeguard_checkins"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_packets" ADD CONSTRAINT "approval_packets_ticket_id_improvement_tickets_ticket_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."improvement_tickets"("ticket_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_packets" ADD CONSTRAINT "approval_packets_plan_id_change_plans_plan_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."change_plans"("plan_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_queue" ADD CONSTRAINT "approval_queue_packet_id_approval_packets_packet_id_fk" FOREIGN KEY ("packet_id") REFERENCES "public"."approval_packets"("packet_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_plans" ADD CONSTRAINT "change_plans_ticket_id_improvement_tickets_ticket_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."improvement_tickets"("ticket_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_items" ADD CONSTRAINT "evidence_items_ticket_id_improvement_tickets_ticket_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."improvement_tickets"("ticket_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "summaries_device_idx" ON "conversation_summaries" USING btree ("device_id");--> statement-breakpoint
CREATE INDEX "media_attachments_message_idx" ON "media_attachments" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "media_attachments_packet_idx" ON "media_attachments" USING btree ("visual_packet_id");--> statement-breakpoint
CREATE INDEX "memories_device_idx" ON "memories" USING btree ("device_id");--> statement-breakpoint
CREATE INDEX "messages_device_created_idx" ON "messages" USING btree ("device_id","created_at");--> statement-breakpoint
CREATE INDEX "proactive_sends_device_sent_idx" ON "proactive_sends" USING btree ("device_id","sent_at");--> statement-breakpoint
CREATE INDEX "safeguard_appointment_export_deliveries_appt_idx" ON "safeguard_appointment_export_deliveries" USING btree ("appointment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "safeguard_appointment_export_deliveries_token_unique" ON "safeguard_appointment_export_deliveries" USING btree ("access_token");--> statement-breakpoint
CREATE INDEX "safeguard_appointment_exports_appt_idx" ON "safeguard_appointment_exports" USING btree ("appointment_id");--> statement-breakpoint
CREATE INDEX "safeguard_appointment_summaries_appt_idx" ON "safeguard_appointment_summaries" USING btree ("appointment_id");--> statement-breakpoint
CREATE INDEX "safeguard_appointment_utterances_appt_created_idx" ON "safeguard_appointment_utterances" USING btree ("appointment_id","created_at");--> statement-breakpoint
CREATE INDEX "safeguard_appointments_user_created_idx" ON "safeguard_appointments" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "safeguard_checkins_user_created_idx" ON "safeguard_checkins" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "safeguard_followups_user_created_idx" ON "safeguard_followups" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "safeguard_followups_next_reminder_idx" ON "safeguard_followups" USING btree ("next_reminder_at");--> statement-breakpoint
CREATE INDEX "safeguard_observations_user_created_idx" ON "safeguard_observations" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "safeguard_push_subscriptions_user_idx" ON "safeguard_push_subscriptions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "safeguard_push_subscriptions_endpoint_idx" ON "safeguard_push_subscriptions" USING btree ("endpoint");--> statement-breakpoint
CREATE INDEX "safeguard_reminder_sends_followup_idx" ON "safeguard_reminder_sends" USING btree ("followup_id");--> statement-breakpoint
CREATE INDEX "safeguard_reminder_sends_user_idx" ON "safeguard_reminder_sends" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "safeguard_reminder_sends_slot_unique" ON "safeguard_reminder_sends" USING btree ("followup_id","scheduled_for");--> statement-breakpoint
CREATE INDEX "safeguard_translations_user_created_idx" ON "safeguard_translations" USING btree ("user_id","created_at");
CREATE TABLE "expenses" (
	"id" text PRIMARY KEY NOT NULL,
	"property_id" text NOT NULL,
	"name" text NOT NULL,
	"amount" integer NOT NULL,
	"business_date" text NOT NULL,
	"at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" text PRIMARY KEY NOT NULL,
	"stay_id" text NOT NULL,
	"amount" integer NOT NULL,
	"method" text NOT NULL,
	"shift_id" text NOT NULL,
	"at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pin_guards" (
	"key" text PRIMARY KEY NOT NULL,
	"fails" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "properties" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"bank" jsonb,
	"settings" jsonb NOT NULL,
	"staff_ids" jsonb,
	"staff_can_edit_price" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "room_types" (
	"id" text PRIMARY KEY NOT NULL,
	"property_id" text NOT NULL,
	"name" text NOT NULL,
	"standard_guests" integer NOT NULL,
	"extra_guest_fee" integer NOT NULL,
	"prices" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rooms" (
	"id" text PRIMARY KEY NOT NULL,
	"property_id" text NOT NULL,
	"number" text NOT NULL,
	"type_id" text NOT NULL,
	"floor" integer NOT NULL,
	"row" integer NOT NULL,
	"col" integer NOT NULL,
	"condition" text DEFAULT 'ready' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "services" (
	"id" text PRIMARY KEY NOT NULL,
	"property_id" text NOT NULL,
	"name" text NOT NULL,
	"price" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shifts" (
	"id" text PRIMARY KEY NOT NULL,
	"property_id" text NOT NULL,
	"user_id" text NOT NULL,
	"user_name" text NOT NULL,
	"label" text NOT NULL,
	"business_date" text NOT NULL,
	"opened_at" timestamp with time zone NOT NULL,
	"closed_at" timestamp with time zone,
	"cash_diff" integer,
	"note" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stay_items" (
	"id" text PRIMARY KEY NOT NULL,
	"stay_id" text NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"qty" integer NOT NULL,
	"unit_price" integer NOT NULL,
	"shift_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stay_notes" (
	"id" text PRIMARY KEY NOT NULL,
	"stay_id" text NOT NULL,
	"text" text NOT NULL,
	"by" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"business_date" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stay_photos" (
	"id" text PRIMARY KEY NOT NULL,
	"stay_id" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"content_type" text NOT NULL,
	"data" "bytea" NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stays" (
	"id" text PRIMARY KEY NOT NULL,
	"room_id" text NOT NULL,
	"status" text NOT NULL,
	"guest_name" text DEFAULT '' NOT NULL,
	"guest_phone" text DEFAULT '' NOT NULL,
	"guest_count" integer NOT NULL,
	"standard_guests" integer NOT NULL,
	"extra_guest_fee" integer NOT NULL,
	"rent_type" text NOT NULL,
	"periods" integer NOT NULL,
	"check_in_at" timestamp with time zone NOT NULL,
	"check_out_at" timestamp with time zone,
	"prices" jsonb NOT NULL,
	"final_charge" integer,
	"shift_id" text NOT NULL,
	"check_out_shift_id" text
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"role" text NOT NULL,
	"pin_cipher" text NOT NULL,
	"pin_lookup" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "users_pin_lookup_unique" UNIQUE("pin_lookup")
);
--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_stay_id_stays_id_fk" FOREIGN KEY ("stay_id") REFERENCES "public"."stays"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_shift_id_shifts_id_fk" FOREIGN KEY ("shift_id") REFERENCES "public"."shifts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_types" ADD CONSTRAINT "room_types_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_type_id_room_types_id_fk" FOREIGN KEY ("type_id") REFERENCES "public"."room_types"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stay_items" ADD CONSTRAINT "stay_items_stay_id_stays_id_fk" FOREIGN KEY ("stay_id") REFERENCES "public"."stays"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stay_items" ADD CONSTRAINT "stay_items_shift_id_shifts_id_fk" FOREIGN KEY ("shift_id") REFERENCES "public"."shifts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stay_notes" ADD CONSTRAINT "stay_notes_stay_id_stays_id_fk" FOREIGN KEY ("stay_id") REFERENCES "public"."stays"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stay_photos" ADD CONSTRAINT "stay_photos_stay_id_stays_id_fk" FOREIGN KEY ("stay_id") REFERENCES "public"."stays"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stays" ADD CONSTRAINT "stays_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stays" ADD CONSTRAINT "stays_shift_id_shifts_id_fk" FOREIGN KEY ("shift_id") REFERENCES "public"."shifts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stays" ADD CONSTRAINT "stays_check_out_shift_id_shifts_id_fk" FOREIGN KEY ("check_out_shift_id") REFERENCES "public"."shifts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "expenses_by_business_date" ON "expenses" USING btree ("property_id","business_date");--> statement-breakpoint
CREATE INDEX "payments_by_stay" ON "payments" USING btree ("stay_id");--> statement-breakpoint
CREATE INDEX "payments_by_shift" ON "payments" USING btree ("shift_id");--> statement-breakpoint
CREATE UNIQUE INDEX "rooms_number_per_property" ON "rooms" USING btree ("property_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "one_open_shift_per_property" ON "shifts" USING btree ("property_id") WHERE "shifts"."closed_at" is null;--> statement-breakpoint
CREATE INDEX "shifts_by_business_date" ON "shifts" USING btree ("property_id","business_date");--> statement-breakpoint
CREATE INDEX "stay_items_by_stay" ON "stay_items" USING btree ("stay_id");--> statement-breakpoint
CREATE INDEX "stay_notes_by_stay" ON "stay_notes" USING btree ("stay_id");--> statement-breakpoint
CREATE INDEX "stay_photos_by_stay" ON "stay_photos" USING btree ("stay_id");--> statement-breakpoint
CREATE INDEX "stays_by_room" ON "stays" USING btree ("room_id","status");
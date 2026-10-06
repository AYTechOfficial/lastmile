CREATE TABLE "lastmile"."user_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"service" text NOT NULL,
	"value_encrypted" text NOT NULL,
	"label" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "lastmile"."user_credentials" ADD CONSTRAINT "user_credentials_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "lastmile"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "user_credentials_user_service" ON "lastmile"."user_credentials" USING btree ("user_id","service");--> statement-breakpoint
ALTER TABLE "lastmile"."user" DROP COLUMN "github_token_encrypted";--> statement-breakpoint
ALTER TABLE "lastmile"."user" DROP COLUMN "vercel_token_encrypted";
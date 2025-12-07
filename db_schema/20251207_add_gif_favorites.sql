-- =============================================
-- GIF Favorites Table
-- Allows users to save favorite GIFs from Tenor
-- =============================================

-- Create the gif_favorites table
CREATE TABLE IF NOT EXISTS "public"."gif_favorites" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "tenor_id" "text" NOT NULL,
    "gif_url" "text" NOT NULL,
    "preview_url" "text" NOT NULL,
    "title" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "gif_favorites_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "gif_favorites_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE,
    CONSTRAINT "gif_favorites_unique" UNIQUE ("user_id", "tenor_id")
);

ALTER TABLE "public"."gif_favorites" OWNER TO "postgres";

COMMENT ON TABLE "public"."gif_favorites" IS 'User GIF favorites - stores references to Tenor GIFs';
COMMENT ON COLUMN "public"."gif_favorites"."tenor_id" IS 'Tenor GIF ID for deduplication';
COMMENT ON COLUMN "public"."gif_favorites"."gif_url" IS 'Full resolution GIF URL';
COMMENT ON COLUMN "public"."gif_favorites"."preview_url" IS 'Preview/thumbnail URL for faster loading';

-- Create index for faster lookups
CREATE INDEX IF NOT EXISTS "idx_gif_favorites_user_id" ON "public"."gif_favorites"("user_id");
CREATE INDEX IF NOT EXISTS "idx_gif_favorites_user_tenor" ON "public"."gif_favorites"("user_id", "tenor_id");

-- =============================================
-- Row Level Security Policies
-- Users can only manage their own favorites
-- =============================================

ALTER TABLE "public"."gif_favorites" ENABLE ROW LEVEL SECURITY;

-- Users can view their own favorites
CREATE POLICY "Users can view own gif favorites" 
    ON "public"."gif_favorites" 
    FOR SELECT 
    USING (user_id = auth.uid());

-- Users can insert their own favorites
CREATE POLICY "Users can insert own gif favorites" 
    ON "public"."gif_favorites" 
    FOR INSERT 
    WITH CHECK (user_id = auth.uid());

-- Users can delete their own favorites
CREATE POLICY "Users can delete own gif favorites" 
    ON "public"."gif_favorites" 
    FOR DELETE 
    USING (user_id = auth.uid());

-- =============================================
-- Grant permissions
-- =============================================

GRANT ALL ON TABLE "public"."gif_favorites" TO "anon";
GRANT ALL ON TABLE "public"."gif_favorites" TO "authenticated";
GRANT ALL ON TABLE "public"."gif_favorites" TO "service_role";


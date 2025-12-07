-- =============================================
-- Fix GIF Favorites Schema
-- Updates the table to support any animated images, not just Tenor GIFs
-- Removes the old tenor_id column and ensures proper schema
-- =============================================

-- Drop the old tenor_id column if it exists
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 
        FROM information_schema.columns 
        WHERE table_schema = 'public' 
        AND table_name = 'gif_favorites' 
        AND column_name = 'tenor_id'
    ) THEN
        ALTER TABLE "public"."gif_favorites" DROP COLUMN "tenor_id";
        RAISE NOTICE 'Dropped tenor_id column from gif_favorites';
    END IF;
END
$$;

-- Ensure gif_url column exists and is NOT NULL
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 
        FROM information_schema.columns 
        WHERE table_schema = 'public' 
        AND table_name = 'gif_favorites' 
        AND column_name = 'gif_url'
    ) THEN
        ALTER TABLE "public"."gif_favorites" ADD COLUMN "gif_url" text NOT NULL;
        RAISE NOTICE 'Added gif_url column to gif_favorites';
    END IF;
END
$$;

-- Ensure preview_url column exists and is NOT NULL
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 
        FROM information_schema.columns 
        WHERE table_schema = 'public' 
        AND table_name = 'gif_favorites' 
        AND column_name = 'preview_url'
    ) THEN
        ALTER TABLE "public"."gif_favorites" ADD COLUMN "preview_url" text NOT NULL;
        RAISE NOTICE 'Added preview_url column to gif_favorites';
    END IF;
END
$$;

-- Ensure title column exists (nullable)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 
        FROM information_schema.columns 
        WHERE table_schema = 'public' 
        AND table_name = 'gif_favorites' 
        AND column_name = 'title'
    ) THEN
        ALTER TABLE "public"."gif_favorites" ADD COLUMN "title" text;
        RAISE NOTICE 'Added title column to gif_favorites';
    END IF;
END
$$;

-- Drop old unique constraint on tenor_id if it exists
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 
        FROM pg_constraint 
        WHERE conname = 'gif_favorites_unique_tenor_id'
    ) THEN
        ALTER TABLE "public"."gif_favorites" DROP CONSTRAINT "gif_favorites_unique_tenor_id";
        RAISE NOTICE 'Dropped old unique constraint on tenor_id';
    END IF;
END
$$;

-- Ensure unique constraint on (user_id, gif_url) exists
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 
        FROM pg_constraint 
        WHERE conname = 'gif_favorites_unique_url'
    ) THEN
        ALTER TABLE "public"."gif_favorites" 
        ADD CONSTRAINT "gif_favorites_unique_url" UNIQUE ("user_id", "gif_url");
        RAISE NOTICE 'Added unique constraint on (user_id, gif_url)';
    END IF;
END
$$;

-- Update table comment
COMMENT ON TABLE "public"."gif_favorites" IS 'User GIF favorites - stores references to GIFs from any source (Tenor, Giphy, or direct URLs)';
COMMENT ON COLUMN "public"."gif_favorites"."gif_url" IS 'Full resolution GIF URL (unique identifier)';
COMMENT ON COLUMN "public"."gif_favorites"."preview_url" IS 'Preview/thumbnail URL for faster loading';
COMMENT ON COLUMN "public"."gif_favorites"."title" IS 'Optional title/description of the GIF';


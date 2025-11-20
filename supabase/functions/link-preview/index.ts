// Harmony Link Preview Edge Function
// Provides cached metadata for URLs (Harmony posts, YouTube, Spotify, generic)

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { createHash } from "https://deno.land/std@0.168.0/hash/mod.ts";
import {
  corsHeaders,
  getAvatarPublicUrl,
} from "../common/index.ts";

type EmbedProvider = "harmony-post" | "youtube" | "spotify" | "generic";

interface HarmonyPostSummary {
  postId: string;
  instanceDomain: string;
  visibility: string;
  isLocal: boolean;
  author?: {
    id: string;
    username: string;
    display_name?: string;
    domain?: string;
    avatar_url?: string | null;
    color?: string | null;
  };
}

interface EmbedPayload {
  cacheKey: string;
  url: string;
  normalizedUrl: string;
  provider: EmbedProvider;
  title?: string;
  description?: string;
  siteName?: string;
  image?: string;
  icon?: string;
  color?: string;
  html?: string;
  width?: number;
  height?: number;
  harmony?: HarmonyPostSummary;
  oEmbed?: Record<string, unknown>;
  fetchedAt: string;
  expiresAt: string;
}

interface ErrorBody {
  error: {
    message: string;
    code?: string;
    provider?: EmbedProvider;
  };
}

const BUCKET_NAME = "link-embeds";
const DEFAULT_USER_AGENT = "HarmonyLinkEmbeds/1.0 (+https://har.mony.lol)";

const TTL_BY_PROVIDER: Record<EmbedProvider, number> = {
  "harmony-post": 5 * 60 * 1000, // 5 minutes
  youtube: 6 * 60 * 60 * 1000,   // 6 hours
  spotify: 6 * 60 * 60 * 1000,   // 6 hours
  generic: 24 * 60 * 60 * 1000,  // 24 hours
};

serve(async (req: Request) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST" && req.method !== "GET") {
    return respondError("Method not allowed", 405);
  }

  try {
    const targetUrl = await resolveUrlFromRequest(req);
    if (!targetUrl) {
      return respondError("URL is required", 400);
    }

    const normalizedUrl = normalizeUrl(targetUrl);
    if (!normalizedUrl) {
      return respondError("Invalid URL", 400);
    }

    const urlObj = new URL(normalizedUrl);
    if (!["http:", "https:"].includes(urlObj.protocol)) {
      return respondError("Only HTTP/HTTPS URLs are supported", 400);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !supabaseKey) {
      console.error("Missing SUPABASE credentials");
      return respondError("Server misconfiguration", 500);
    }

    const supabase = createClient(supabaseUrl, supabaseKey);
    const provider = detectProvider(urlObj);
    const cacheKey = createCacheKey(provider, normalizedUrl);
    const storagePath = `${provider}/${cacheKey}.json`;

    const cached = await readCachedEmbed(supabase, storagePath);
    if (cached && !isExpired(cached.expiresAt)) {
      return respondSuccess(cached, true);
    }

    const embed = await buildEmbedForProvider(provider, urlObj, supabase);
    const payload: EmbedPayload = {
      ...embed,
      cacheKey,
      url: targetUrl,
      normalizedUrl,
      provider,
      fetchedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + TTL_BY_PROVIDER[provider]).toISOString(),
    };

    await writeCachedEmbed(supabase, storagePath, payload);
    return respondSuccess(payload, false);
  } catch (error) {
    console.error("Link preview error:", error);
    return respondError(error.message || "Failed to build preview", 500);
  }
});

async function resolveUrlFromRequest(req: Request): Promise<string | null> {
  if (req.method === "GET") {
    const url = new URL(req.url);
    return url.searchParams.get("url");
  }

  try {
    const body = await req.json();
    if (typeof body?.url === "string") {
      return body.url;
    }
    return null;
  } catch (_err) {
    return null;
  }
}

function normalizeUrl(rawUrl: string): string | null {
  try {
    let value = rawUrl.trim();
    if (!/^https?:\/\//i.test(value)) {
      value = `https://${value}`;
    }
    const url = new URL(value);
    // Lowercase host and protocol for cache stability
    url.hostname = url.hostname.toLowerCase();
    url.protocol = url.protocol.toLowerCase();
    // Remove default ports
    if ((url.protocol === "https:" && url.port === "443") || (url.protocol === "http:" && url.port === "80")) {
      url.port = "";
    }
    return url.toString();
  } catch (_err) {
    return null;
  }
}

function detectProvider(url: URL): EmbedProvider {
  if (isHarmonyPostUrl(url)) {
    return "harmony-post";
  }
  if (isYouTubeUrl(url)) {
    return "youtube";
  }
  if (isSpotifyUrl(url)) {
    return "spotify";
  }
  return "generic";
}

function isHarmonyPostUrl(url: URL): boolean {
  const primaryDomain = (Deno.env.get("DOMAIN") || "har.mony.lol").toLowerCase();
  const extraDomains = (Deno.env.get("HARMONY_ALT_DOMAINS") || "")
    .split(",")
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
  const allowedHosts = new Set([primaryDomain, ...extraDomains]);

  return (
    allowedHosts.has(url.hostname.toLowerCase()) &&
    /^\/posts\/[a-zA-Z0-9-]+/.test(url.pathname)
  );
}

function isYouTubeUrl(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  return (
    host === "youtube.com" ||
    host === "www.youtube.com" ||
    host === "m.youtube.com" ||
    host === "youtu.be"
  );
}

function isSpotifyUrl(url: URL): boolean {
  return url.hostname.toLowerCase().endsWith("spotify.com");
}

function createCacheKey(provider: EmbedProvider, normalizedUrl: string): string {
  return createHash("sha256").update(`${provider}|${normalizedUrl}`).toString();
}

async function readCachedEmbed(
  supabase: ReturnType<typeof createClient>,
  path: string,
): Promise<EmbedPayload | null> {
  const { data, error } = await supabase.storage.from(BUCKET_NAME).download(path);
  if (error) {
    const status = typeof error.statusCode === "number" ? error.statusCode : Number(error.status);
    if (status === 404 || /not\s+found/i.test(error.message || "")) {
      return null;
    }
    console.warn("Failed to read cache:", error.message);
    return null;
  }

  try {
    const text = await (data as Blob).text();
    const parsed = JSON.parse(text);
    return parsed as EmbedPayload;
  } catch (err) {
    console.warn("Failed to parse cached embed:", err);
    return null;
  }
}

async function writeCachedEmbed(
  supabase: ReturnType<typeof createClient>,
  path: string,
  payload: EmbedPayload,
): Promise<void> {
  const body = JSON.stringify(payload);
  const { error } = await supabase.storage.from(BUCKET_NAME).upload(
    path,
    new Blob([body], { type: "application/json" }),
    { upsert: true, contentType: "application/json" },
  );

  if (error) {
    console.warn("Failed to write cache:", error.message);
  }
}

function isExpired(expiresAt: string): boolean {
  if (!expiresAt) return true;
  return Date.now() >= new Date(expiresAt).getTime();
}

async function buildEmbedForProvider(
  provider: EmbedProvider,
  url: URL,
  supabase: ReturnType<typeof createClient>,
): Promise<Partial<EmbedPayload>> {
  switch (provider) {
    case "harmony-post":
      return await buildHarmonyPostEmbed(url, supabase);
    case "youtube":
      return await fetchOEmbed(url, "https://www.youtube.com/oembed");
    case "spotify":
      return await fetchOEmbed(url, "https://open.spotify.com/oembed");
    default:
      return await fetchGenericMetadata(url);
  }
}

async function buildHarmonyPostEmbed(
  url: URL,
  supabase: ReturnType<typeof createClient>,
): Promise<Partial<EmbedPayload>> {
  const match = url.pathname.match(/^\/posts\/([a-zA-Z0-9-]+)/);
  if (!match) {
    throw new Error("Invalid Harmony post URL");
  }

  const postId = match[1];
  const { data: post, error } = await supabase
    .from("posts")
    .select(`
      id,
      content,
      content_warning,
      visibility,
      is_deleted,
      is_local,
      url,
      ap_id,
      created_at,
      media_attachments,
      author:profiles!posts_author_id_fkey(
        id,
        username,
        display_name,
        domain,
        avatar_url,
        color
      )
    `)
    .eq("id", postId)
    .single();

  if (error || !post) {
    throw new Error("Harmony post not found");
  }

  if (post.is_deleted) {
    throw new Error("Post is no longer available");
  }

  if (!["public", "unlisted"].includes(post.visibility)) {
    throw new Error("Post is not embeddable");
  }

  const summary = extractTextSummary(post.content) || "View post on Harmony";
  const authorDisplay = post.author?.display_name || post.author?.username || "Unknown";
  const firstImage = extractFirstImage(post);
  const avatarUrl = getAvatarPublicUrl(supabase, post.author?.avatar_url) || undefined;

  return {
    title: authorDisplay,
    description: summary,
    siteName: url.hostname,
    image: firstImage,
    icon: avatarUrl,
    color: post.author?.color || undefined,
    harmony: {
      postId: post.id,
      instanceDomain: url.hostname,
      visibility: post.visibility,
      isLocal: post.is_local,
      author: {
        id: post.author?.id,
        username: post.author?.username,
        display_name: post.author?.display_name,
        domain: post.author?.domain,
        avatar_url: avatarUrl ?? null,
        color: post.author?.color ?? null,
      },
    },
  };
}

async function fetchOEmbed(url: URL, endpoint: string): Promise<Partial<EmbedPayload>> {
  const requestUrl = new URL(endpoint);
  requestUrl.searchParams.set("url", url.toString());
  requestUrl.searchParams.set("format", "json");

  const response = await fetchWithTimeout(requestUrl.toString());
  if (!response.ok) {
    throw new Error(`Failed to load oEmbed data (${response.status})`);
  }

  const data = await response.json();
  return {
    title: data.title || data.author_name || url.hostname,
    description: data.author_name || data.provider_name,
    siteName: data.provider_name || url.hostname,
    image: data.thumbnail_url,
    html: data.html,
    width: data.width,
    height: data.height,
    oEmbed: data,
  };
}

async function fetchGenericMetadata(url: URL): Promise<Partial<EmbedPayload>> {
  const response = await fetchWithTimeout(url.toString(), {
    headers: { "User-Agent": DEFAULT_USER_AGENT },
  });

  if (!response.ok) {
    throw new Error(`Failed to load URL (${response.status})`);
  }

  const html = await response.text();
  const meta = extractMetaTags(html);

  const title = meta["og:title"] || meta["twitter:title"] || extractTitle(html) || url.hostname;
  const description = meta["og:description"] || meta["description"] || meta["twitter:description"] || "";
  const image = meta["og:image"] || meta["twitter:image"] || undefined;
  const siteName = meta["og:site_name"] || url.hostname;
  const icon = meta["shortcut icon"] || meta["icon"] || `${url.origin}/favicon.ico`;

  return {
    title,
    description,
    siteName,
    image,
    icon,
  };
}

async function fetchWithTimeout(url: string, init?: RequestInit, timeoutMs = 10_000): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

function extractMetaTags(html: string): Record<string, string> {
  const tags: Record<string, string> = {};
  const metaRegex = /<meta\b[^>]*>/gi;
  const attrRegex = /\b(name|property|content|itemprop)=["']([^"']+)["']/gi;

  let metaMatch;
  while ((metaMatch = metaRegex.exec(html)) !== null) {
    const tag = metaMatch[0];
    const attributes: Record<string, string> = {};
    attrRegex.lastIndex = 0;
    let attrMatch;
    while ((attrMatch = attrRegex.exec(tag)) !== null) {
      attributes[attrMatch[1].toLowerCase()] = attrMatch[2];
    }

    const key = attributes.name || attributes.property || attributes.itemprop;
    if (key && attributes.content) {
      tags[key.toLowerCase()] = attributes.content;
    }
  }

  return tags;
}

function extractTitle(html: string): string | undefined {
  const match = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  return match ? match[1].trim() : undefined;
}

function extractTextSummary(content: any): string {
  if (!Array.isArray(content)) return "";
  const pieces: string[] = [];

  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    switch (part.type) {
      case "text":
        if (typeof part.text === "string") {
          pieces.push(part.text);
        }
        break;
      case "mention":
        if (part.username) {
          pieces.push(`@${part.username}`);
        }
        break;
      case "hashtag":
        if (part.name) {
          pieces.push(`#${part.name}`);
        }
        break;
      case "url":
        if (part.url) {
          pieces.push(part.url);
        }
        break;
      case "emoji":
        if (part.emoji?.name) {
          pieces.push(`:${part.emoji.name}:`);
        }
        break;
      default:
        break;
    }
    if (pieces.join(" ").length > 240) {
      break;
    }
  }

  return pieces.join(" ").trim();
}

function extractFirstImage(post: Record<string, unknown>): string | undefined {
  const attachments = Array.isArray(post.media_attachments) ? post.media_attachments : [];
  const mediaImage = attachments.find((att: any) =>
    att?.type === "image" && (att.url || att.preview_url)
  );
  if (mediaImage) {
    return mediaImage.preview_url || mediaImage.url;
  }

  const content = Array.isArray(post.content) ? post.content : [];
  for (const part of content) {
    if (part?.type === "file" && part.fileType === "image" && part.url) {
      return part.url;
    }
    if (part?.type === "url" && typeof part.url === "string" && /\.(png|jpe?g|gif|webp)$/i.test(part.url)) {
      return part.url;
    }
  }

  return undefined;
}

function respondSuccess(payload: EmbedPayload, cached: boolean): Response {
  return new Response(
    JSON.stringify({ data: payload, cached }),
    {
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      },
    },
  );
}

function respondError(message: string, status = 500, code?: string, provider?: EmbedProvider): Response {
  const body: ErrorBody = { error: { message, code, provider } };
  return new Response(
    JSON.stringify(body),
    {
      status,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
      },
    },
  );
}


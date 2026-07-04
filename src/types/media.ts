// Split out of the former monolithic src/types.ts. Import via '@/types'.

export interface Gif {
  id: string;
  // add more formats?
  media_formats: {
      gif: {url:string},
      gifpreview: {url:string},
      mp4: {url:string},
      webm: {url:string}
  }
  title?: string;
  /** Klipy item page URL (for attribution link on shared GIFs). */
  itemUrl?: string;
  /** True for clip media (video) — sent/rendered as a video, not an image. */
  isVideo?: boolean;
}

/**
 * A GIF feed item from the backend Klipy proxy. Either a GIF (same shape as
 * `Gif`) or a Klipy ad (HTML rendered in a sandboxed iframe). Ad items are only
 * present for viewers the backend decided should see ads.
 */
export interface GifAdItem {
  kind: 'ad';
  id: string;
  content: string;
  width: number;
  height: number;
}
export type GifResultItem = (Gif & { kind: 'gif' }) | GifAdItem;

export interface Emoji {
  id: string;
  created_at?: Date;
  updated_at?: Date;
  name: string;
  url: string;
  /** Byte size of the uploaded image file */
  file_size?: number;
  uploader?: string;
  server_id?: string;
  usage_count?: number;
  last_used?: Date;
  /** Ownership scope: 'server' | 'instance' | 'user'. Absent = legacy server emoji. */
  scope?: 'server' | 'instance' | 'user';
  /** True for emoji created via the Klipy AI generation API. */
  is_ai_generated?: boolean;
  /**
   * Native unicode emoji codepoint(s) when this `Emoji` is a wrapper around
   * a system emoji rather than a custom server emoji. Set by reaction code
   * paths that need to round-trip a native emoji through the `Emoji` type.
   */
  content?: string;
}
export type ResolvedEmoji = Emoji & {
  display_name: string;
};

export interface Point {
  x: number;
  y: number;
  color: string;
}


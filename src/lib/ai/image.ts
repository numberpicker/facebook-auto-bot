import { randomUUID } from "crypto";
import { env } from "@/lib/env";
import { supabaseAdmin } from "@/lib/supabase/server";
import type { ImageSource, ImageSourcePref } from "@/lib/types";

const STORAGE_BUCKET = "post-images";

// Square reads well in the Facebook feed on both mobile and desktop, and
// avoids the centre-crop that wide images get in the timeline.
const WIDTH = 1200;
const HEIGHT = 1200;

const GEMINI_IMAGE_MODEL = "gemini-2.5-flash-image";

export function resolveImageSource(pref: ImageSourcePref): ImageSource {
  if (pref === "mixed") return Math.random() < 0.5 ? "ai" : "stock";
  return pref;
}

/**
 * Topics phrased as listicles ("easy weeknight dinner ideas") make the model
 * return a grid of thumbnails, which reads as a stock collage in the feed.
 * Steering it toward one photographed subject fixes that.
 */
const PHOTO_STYLE =
  "single subject, professional photograph, natural light, shallow depth of field, high detail, no text, no watermark, no collage, no grid";

/**
 * Gemini's image model returns the picture as base64 inline data rather than
 * a URL, so it is decoded into a Blob here to match what the uploader and the
 * Pollinations/Pexels paths already produce.
 */
async function fetchGeminiImageBytes(prompt: string, apiKey: string): Promise<Blob> {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_IMAGE_MODEL}:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: `${prompt}, ${PHOTO_STYLE}` }] }],
      }),
      signal: AbortSignal.timeout(60_000),
    }
  );

  if (!res.ok) {
    if (res.status === 429) throw new Error("Gemini image quota exceeded");
    if (res.status === 400 || res.status === 403) {
      throw new Error(`Gemini rejected the key (${res.status})`);
    }
    throw new Error(`Gemini image API ${res.status}`);
  }

  const data = await res.json();
  const parts: Array<{ inlineData?: { data?: string; mimeType?: string } }> =
    data?.candidates?.[0]?.content?.parts ?? [];
  const inline = parts.find((p) => p.inlineData?.data)?.inlineData;
  if (!inline?.data) throw new Error("Gemini returned no image data");

  const bytes = Buffer.from(inline.data, "base64");
  return new Blob([bytes], { type: inline.mimeType || "image/png" });
}

/**
 * AI-generated image, Gemini first and Pollinations as the fallback. Both are
 * best-effort: the free Gemini tier has a daily image quota that is easy to
 * hit, and Pollinations is a keyless community service with no uptime
 * guarantee — so whichever succeeds, the bytes are re-hosted in our own
 * Storage bucket before being returned.
 */
async function fetchAiImageBytes(prompt: string): Promise<Blob> {
  const geminiKey = env.geminiApiKey;

  if (geminiKey) {
    try {
      return await fetchGeminiImageBytes(prompt, geminiKey);
    } catch (err) {
      // Fall through to Pollinations rather than failing the request — the
      // free Gemini tier has a daily image quota and it is easy to hit.
      console.warn(
        "[generateImage] Gemini failed, trying Pollinations:",
        err instanceof Error ? err.message : err
      );
    }
  }

  const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(
    `${prompt}, ${PHOTO_STYLE}`
  )}?width=${WIDTH}&height=${HEIGHT}&nologo=true&seed=${Math.floor(Math.random() * 1_000_000)}`;

  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`Pollinations image API ${res.status}`);
  return res.blob();
}

async function fetchStockImageBytes(query: string): Promise<Blob> {
  if (!env.pexelsApiKey) throw new Error("PEXELS_API_KEY is not configured");

  const searchUrl = `https://api.pexels.com/v1/search?${new URLSearchParams({
    query,
    orientation: "square",
    per_page: "10",
  })}`;
  const searchRes = await fetch(searchUrl, {
    headers: { Authorization: env.pexelsApiKey },
    signal: AbortSignal.timeout(15_000),
  });
  if (!searchRes.ok) throw new Error(`Pexels search failed (${searchRes.status})`);
  const data = await searchRes.json();
  const photos: Array<{ src: { large2x: string; large: string } }> = data.photos ?? [];
  if (photos.length === 0) throw new Error("No stock photos found for this topic");

  const chosen = photos[Math.floor(Math.random() * photos.length)];
  const imageRes = await fetch(chosen.src.large2x ?? chosen.src.large, {
    signal: AbortSignal.timeout(20_000),
  });
  if (!imageRes.ok) throw new Error("Failed to download chosen stock photo");
  return imageRes.blob();
}

/**
 * Generates or sources a post image, then re-hosts it in our own Supabase
 * Storage bucket rather than linking the free provider's URL directly. Both
 * free providers are best-effort community services with no uptime guarantee —
 * re-hosting means a post's image keeps working forever, and Facebook's own
 * fetcher (which downloads the image itself at publish time) always sees a
 * stable, fast, first-party URL.
 */
export async function generateImage(
  prompt: string,
  pref: ImageSourcePref
): Promise<{ url: string; source: ImageSource }> {
  const source = resolveImageSource(pref);

  let blob: Blob;
  try {
    blob = source === "ai" ? await fetchAiImageBytes(prompt) : await fetchStockImageBytes(prompt);
  } catch (err) {
    // Fall back to the other free source rather than failing the whole generation.
    const fallbackSource: ImageSource = source === "ai" ? "stock" : "ai";
    try {
      blob =
        fallbackSource === "ai"
          ? await fetchAiImageBytes(prompt)
          : await fetchStockImageBytes(prompt);
      return await upload(blob, fallbackSource);
    } catch {
      throw err instanceof Error ? err : new Error("Image generation failed");
    }
  }

  return upload(blob, source);
}

async function upload(blob: Blob, source: ImageSource): Promise<{ url: string; source: ImageSource }> {
  const db = supabaseAdmin();
  const path = `${new Date().toISOString().slice(0, 10)}/${randomUUID()}.jpg`;
  const bytes = new Uint8Array(await blob.arrayBuffer());

  const { error } = await db.storage.from(STORAGE_BUCKET).upload(path, bytes, {
    contentType: blob.type || "image/jpeg",
    upsert: false,
  });
  if (error) throw new Error(`Storage upload failed: ${error.message}`);

  const { data } = db.storage.from(STORAGE_BUCKET).getPublicUrl(path);
  return { url: data.publicUrl, source };
}

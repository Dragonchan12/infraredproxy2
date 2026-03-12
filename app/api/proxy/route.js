import {
  parseAndValidateTarget,
} from "@/lib/proxy";
import { handleProxyRequest } from "@/lib/proxy-request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function resolveTargetFromQuery(request) {
  const { searchParams } = new URL(request.url);
  let rawUrl = searchParams.get("url");
  if (!rawUrl) {
    const referer = request.headers.get("referer");
    if (referer) {
      try {
        const refUrl = new URL(referer);
        const refTarget = refUrl.searchParams.get("url");
        if (refTarget) {
          const base = new URL(refTarget);
          const relative = new URL(request.url).search || "";
          const resolved = new URL(relative || "", base);
          rawUrl = resolved.toString();
        }
      } catch {
        // Ignore referer fallback errors.
      }
    }
  }
  return rawUrl;
}

export async function GET(request) {
  const rawUrl = await resolveTargetFromQuery(request);
  return handleProxyRequest(request, rawUrl);
}

export async function HEAD(request) {
  const rawUrl = await resolveTargetFromQuery(request);
  return handleProxyRequest(request, rawUrl);
}

export async function POST(request) {
  const rawUrl = await resolveTargetFromQuery(request);
  return handleProxyRequest(request, rawUrl);
}

export async function PUT(request) {
  const rawUrl = await resolveTargetFromQuery(request);
  return handleProxyRequest(request, rawUrl);
}

export async function PATCH(request) {
  const rawUrl = await resolveTargetFromQuery(request);
  return handleProxyRequest(request, rawUrl);
}

export async function DELETE(request) {
  const rawUrl = await resolveTargetFromQuery(request);
  return handleProxyRequest(request, rawUrl);
}

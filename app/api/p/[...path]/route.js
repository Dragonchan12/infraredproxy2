import { handleProxyRequest } from "@/lib/proxy-request";
import { decodeUrlToken } from "@/lib/proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function buildTargetUrl(pathSegments, requestUrl) {
  if (!pathSegments || pathSegments.length < 2) return "";
  if (pathSegments[0] === "e" && pathSegments[1]) {
    const decoded = decodeUrlToken(pathSegments[1]);
    if (!decoded) return "";
    if (pathSegments.length > 2) {
      const rest = pathSegments.slice(2).join("/");
      let base = decoded;
      try {
        base = new URL(decoded).origin;
      } catch {
        base = decoded.endsWith("/") ? decoded.slice(0, -1) : decoded;
      }
      return `${base}/${rest}${requestUrl.search || ""}`;
    }
    return decoded;
  }
  const [scheme, host, ...rest] = pathSegments;
  if (!scheme || !host) return "";
  const path = rest.length ? `/${rest.join("/")}` : "/";
  const search = requestUrl.search || "";
  return `${scheme}://${host}${path}${search}`;
}

async function handle(request, { params }) {
  const requestUrl = new URL(request.url);
  const rawUrl = buildTargetUrl(params.path, requestUrl);
  if (!rawUrl) {
    return Response.json({ error: "Missing proxy target." }, { status: 400 });
  }
  return handleProxyRequest(request, rawUrl);
}

export async function GET(request, ctx) {
  return handle(request, ctx);
}

export async function HEAD(request, ctx) {
  return handle(request, ctx);
}

export async function POST(request, ctx) {
  return handle(request, ctx);
}

export async function PUT(request, ctx) {
  return handle(request, ctx);
}

export async function PATCH(request, ctx) {
  return handle(request, ctx);
}

export async function DELETE(request, ctx) {
  return handle(request, ctx);
}

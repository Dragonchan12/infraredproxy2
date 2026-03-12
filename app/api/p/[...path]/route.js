import { handleProxyRequest } from "@/lib/proxy-request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function buildTargetUrl(pathSegments, requestUrl) {
  if (!pathSegments || pathSegments.length < 2) return "";
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

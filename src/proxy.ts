import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// Password-protects /admin with HTTP Basic auth (user: anything, password: ADMIN_PASSWORD).
// In production without ADMIN_PASSWORD the admin page is simply not reachable.
export function proxy(request: NextRequest) {
  // Through a public tunnel (Cloudflare adds cf-connecting-ip), admin is simply not there: it opens only on this
  // Mac or the same Wi-Fi. On the real deployment set ADMIN_PUBLIC=1 (with a strong ADMIN_PASSWORD).
  if (request.headers.get("cf-connecting-ip") && process.env.ADMIN_PUBLIC !== "1") return new NextResponse("Not found", { status: 404 });
  const password = process.env.ADMIN_PASSWORD;
  if (!password) {
    return process.env.NODE_ENV === "production" ? new NextResponse("Not found", { status: 404 }) : NextResponse.next();
  }
  const header = request.headers.get("authorization") ?? "";
  const [scheme, encoded] = header.split(" ");
  if (scheme === "Basic" && encoded) {
    try {
      const decoded = atob(encoded);
      if (decoded.slice(decoded.indexOf(":") + 1) === password) return NextResponse.next();
    } catch {
      // malformed header → ask again
    }
  }
  return new NextResponse("Authentication required", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="free-chat admin"' },
  });
}

export const config = { matcher: ["/admin/:path*"] };

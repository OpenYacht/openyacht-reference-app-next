import type { NextConfig } from "next";

// Development only. `next dev` refuses requests for its dev-only assets (hot
// reload among them) from any hostname but localhost and the one it was
// started with. Two other hostnames legitimately reach a dev server here: the
// identity domain, once a tunnel points it at this machine, and whatever is
// listed in ALLOWED_DEV_ORIGINS — a LAN address, say, for testing from another
// device. Hostnames only: no scheme, no port. Has no effect on a production build.
const allowedDevOrigins = [process.env.OPENYACHT_DOMAIN, ...(process.env.ALLOWED_DEV_ORIGINS ?? "").split(",")]
  .map((hostname) => hostname?.trim().toLowerCase() ?? "")
  .filter((hostname) => hostname !== "");

const nextConfig: NextConfig = {
  allowedDevOrigins,
};

export default nextConfig;

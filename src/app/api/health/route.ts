// Liveness: the process is up. Never touches the database.
export const dynamic = "force-dynamic";

export function GET() {
  return Response.json({ status: "ok" });
}

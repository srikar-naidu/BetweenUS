export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const dns = await import("node:dns");
    dns.setServers(["8.8.8.8", "1.1.1.1"]);
  }
}
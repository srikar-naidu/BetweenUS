import Link from "next/link";
import { redirect } from "next/navigation";
import { FriendsDirectory } from "@/components/friends-directory";
import { getAuth, getAuthConfigurationStatus } from "@/lib/auth";
import { headers } from "next/headers";

export const dynamic = "force-dynamic";

export default async function FriendsPage() {
  if (!getAuthConfigurationStatus().configured) redirect("/sign-in");
  const auth = await getAuth();
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect("/sign-in");
  return (
    <>
      <FriendsDirectory />
      <noscript><Link href="/groups">Open your group albums</Link></noscript>
    </>
  );
}

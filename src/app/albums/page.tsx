import Image from "next/image";
import Link from "next/link";
import { ObjectId } from "mongodb";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { AlbumCoverPicker } from "@/components/album-cover-picker";
import { getAuth, getAuthConfigurationStatus } from "@/lib/auth";
import { listGroupsForUser } from "@/lib/auth/group-access";
import { getMongoDatabase } from "@/lib/db/mongodb";
import { MongoMemoryRepository } from "@/lib/repositories/mongodb-memory-repository";

export const dynamic = "force-dynamic";

export default async function AlbumsPage() {
  if (!getAuthConfigurationStatus().configured) redirect("/sign-in");
  const requestHeaders = await headers();
  const auth = await getAuth();
  const session = await auth.api.getSession({ headers: requestHeaders });
  if (!session) redirect("/sign-in");
  const groups = await listGroupsForUser(requestHeaders);
  const database = await getMongoDatabase();
  const albums = await Promise.all(groups.map(async (group) => {
    const memory = new MongoMemoryRepository(database);
    const [groupPosts, cover, groupDocument] = await Promise.all([
      memory.findRecentGroupVisibleFragments(group.id, 101),
      memory.findGroupAlbumCover(group.id),
      database.collection("groups").findOne(
        { _id: new ObjectId(group.id) },
        { projection: { albumCover: 1 } },
      ),
    ]);
    return {
      group,
      count: groupPosts.length,
      cover,
      hasAlbumCover: typeof groupDocument?.albumCover === "object" && groupDocument.albumCover !== null,
      latestAt: groupPosts[0]?.capturedAt ?? null,
    };
  }));

  return (
    <main className="shell trust-page albums-page">
      <section className="intro social-intro">
        <p className="eyebrow">MEMORIES, KEPT TOGETHER</p>
        <h1>Albums</h1>
        <p className="lede">Each private group is one shared album. Invite your people, add moments, and shape the story together.</p>
      </section>
      {albums.length ? (
        <div className="album-grid">
          {albums.map(({ group, count, cover, hasAlbumCover, latestAt }) => (
            <div className="album-entry" key={group.id}>
              <Link className="album-card" href={`/groups/${group.id}`}>
                <div className="album-cover">
                  {hasAlbumCover ? (
                    <Image
                      src={`/api/groups/${group.id}/album-cover`}
                      alt=""
                      width={560}
                      height={420}
                      unoptimized
                    />
                  ) : (
                    <>
                      {(cover?.type === "image" || cover?.type === "screenshot") && (
                        <Image
                          src={`/api/groups/${group.id}/fragments/${cover.id}/media`}
                          alt=""
                          width={560}
                          height={420}
                          unoptimized
                        />
                      )}
                      {cover?.type === "video" && (
                        <video muted playsInline preload="metadata" src={`/api/groups/${group.id}/fragments/${cover.id}/media`} />
                      )}
                      {!cover && <span className="album-cover-initial" aria-hidden="true">{group.name.slice(0, 1).toUpperCase()}</span>}
                    </>
                  )}
                  <span className="album-cover-title">{group.name}</span>
                </div>
                <div className="album-card-copy">
                  <h2>{group.name}</h2>
                  <p>{group.description || "A private album for your group."}</p>
                  <span>{count > 100 ? "100+" : count} shared {count === 1 ? "post" : "posts"}{latestAt ? ` · updated ${new Intl.DateTimeFormat("en", { month: "short", day: "numeric" }).format(latestAt)}` : ""}</span>
                </div>
              </Link>
              <AlbumCoverPicker
                groupId={group.id}
                hasCover={hasAlbumCover}
                canEdit={group.memberRole === "owner" || group.memberRole === "admin"}
              />
            </div>
          ))}
        </div>
      ) : (
        <section className="journal-empty">
          <span className="journal-empty-icon" aria-hidden="true">▧</span>
          <h2>Your first album is waiting.</h2>
          <p>Create a private group for an event or the people you want to remember it with.</p>
          <Link className="primary-button link-button" href="/groups">Create an album</Link>
        </section>
      )}
      <div className="album-create-row">
        <p>An album is private to its members. Adding a friend does not give them access.</p>
        <Link className="secondary-button link-button" href="/groups">Create or manage albums</Link>
      </div>
    </main>
  );
}

import Image from "next/image";
import Link from "next/link";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getAuth, getAuthConfigurationStatus } from "@/lib/auth";
import { listGroupsForUser } from "@/lib/auth/group-access";
import { getMongoDatabase } from "@/lib/db/mongodb";
import { MongoMemoryRepository } from "@/lib/repositories/mongodb-memory-repository";

export const dynamic = "force-dynamic";

interface HomePost {
  id: string;
  groupId: string;
  type: string;
  caption: string | null;
  textContent: string | null;
  capturedAt: Date;
}

function mondayOfWeek(date: Date): Date {
  const monday = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
  return monday;
}

function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function weekNumber(date: Date): number {
  const thursday = new Date(date);
  thursday.setUTCDate(thursday.getUTCDate() + 3 - ((thursday.getUTCDay() + 6) % 7));
  const firstThursday = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 4));
  firstThursday.setUTCDate(firstThursday.getUTCDate() + 3 - ((firstThursday.getUTCDay() + 6) % 7));
  return 1 + Math.round((thursday.getTime() - firstThursday.getTime()) / 604_800_000);
}

export default async function HomePage() {
  if (!getAuthConfigurationStatus().configured) redirect("/sign-in");
  const requestHeaders = await headers();
  const auth = await getAuth();
  const session = await auth.api.getSession({ headers: requestHeaders });
  if (!session) redirect("/sign-in");
  const groups = await listGroupsForUser(requestHeaders);
  const database = await getMongoDatabase();
  const postsByGroup = await Promise.all(groups.map(async (group) => {
    const fragments = await new MongoMemoryRepository(database)
      .findMemberVisibleFragments(group.id, session.user.id);
    return fragments.map((fragment): HomePost => ({
      id: fragment.id,
      groupId: group.id,
      type: fragment.type,
      caption: fragment.caption,
      textContent: fragment.textContent,
      capturedAt: fragment.capturedAt,
    }));
  }));
  const today = mondayOfWeek(new Date());
  const start = new Date(today);
  start.setUTCDate(start.getUTCDate() - 21);
  const posts = postsByGroup.flat().filter((post) =>
    post.capturedAt >= start && post.capturedAt < new Date(today.getTime() + 7 * 86_400_000),
  ).sort((left, right) => right.capturedAt.getTime() - left.capturedAt.getTime());
  const postsByDay = new Map<string, HomePost[]>();
  for (const post of posts) {
    const key = dayKey(post.capturedAt);
    postsByDay.set(key, [...(postsByDay.get(key) ?? []), post]);
  }
  const weeks = Array.from({ length: 4 }, (_, weekIndex) => {
    const weekStart = new Date(start);
    weekStart.setUTCDate(weekStart.getUTCDate() + weekIndex * 7);
    const days = Array.from({ length: 7 }, (_, dayIndex) => {
      const date = new Date(weekStart);
      date.setUTCDate(date.getUTCDate() + dayIndex);
      return { date, posts: postsByDay.get(dayKey(date)) ?? [] };
    });
    return { number: weekNumber(weekStart), days };
  }).reverse();
  const hasAnyPosts = posts.length > 0;

  return (
    <main className="shell trust-page journal-page">
      <section className="journal-welcome">
        <p className="eyebrow">YOUR SHARED PHOTO JOURNAL</p>
        <h1>A week at a time.</h1>
        <p>Small moments from the albums you share with your people.</p>
      </section>
      {weeks.map((week) => (
        <section className="journal-week" key={week.number}>
          <h2>Week {week.number}</h2>
          <div className="journal-days">
            {week.days.map(({ date, posts: dayPosts }) => {
              const post = dayPosts[0];
              return (
                <Link className={`journal-day ${post ? "journal-day--posted" : ""}`} href={post ? `/groups/${post.groupId}` : "/albums"} key={dayKey(date)}>
                  {post?.type === "image" && (
                    <Image
                      src={`/api/groups/${post.groupId}/fragments/${post.id}/media`}
                      alt={post.caption || "Photo shared with your group"}
                      width={220}
                      height={250}
                      unoptimized
                    />
                  )}
                  {post?.type === "video" && (
                    <video aria-label={post.caption || "Video shared with your group"} muted playsInline preload="metadata" src={`/api/groups/${post.groupId}/fragments/${post.id}/media`} />
                  )}
                  {post?.type === "voice" && (
                    <span className="journal-day-audio" aria-hidden="true">▂ ▅ ▃ ▆ ▂ ▄ ▇</span>
                  )}
                  {post && post.type !== "image" && post.type !== "video" && post.type !== "voice" && (
                    <span className="journal-day-copy">{post.type === "voice" ? "♪" : post.textContent ?? post.caption ?? "A shared note"}</span>
                  )}
                  <span className="journal-day-label">
                    <strong>{new Intl.DateTimeFormat("en", { weekday: "short", timeZone: "UTC" }).format(date)}</strong>
                    <small>{new Intl.DateTimeFormat("en", { month: "short", day: "numeric", timeZone: "UTC" }).format(date)}</small>
                  </span>
                  {dayPosts.length > 1 && <span className="journal-day-count">+{dayPosts.length - 1}</span>}
                </Link>
              );
            })}
          </div>
        </section>
      ))}
      {!hasAnyPosts && (
        <section className="journal-empty">
          <span className="journal-empty-icon" aria-hidden="true">▧</span>
          <h2>Your weeks start with a memory.</h2>
          <p>Pick an album and post a photo, a note, or a little moment from your day.</p>
          <Link className="secondary-button link-button" href="/albums">Browse albums</Link>
        </section>
      )}
      <p className="privacy-status">Your home journal includes only posts you are allowed to see in your groups.</p>
    </main>
  );
}

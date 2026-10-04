"use client";

import Image from "next/image";
import { useEffect, useState } from "react";
import type { FriendProfile } from "@/lib/domain/memory";

interface FriendsData {
  discoverable: boolean;
  friends: FriendProfile[];
  incomingRequests: FriendProfile[];
  outgoingRequests: FriendProfile[];
  results: FriendProfile[];
}

function initials(name: string): string {
  return name.split(/\s+/).slice(0, 2).map((part) => part[0] ?? "").join("").toUpperCase();
}

export function FriendsDirectory() {
  const [data, setData] = useState<FriendsData>({
    discoverable: false,
    friends: [],
    incomingRequests: [],
    outgoingRequests: [],
    results: [],
  });
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      setLoading(true);
      try {
        const response = await fetch(`/api/friends?q=${encodeURIComponent(query)}`, { cache: "no-store" });
        const result = await response.json() as FriendsData & { error?: string };
        if (!response.ok) throw new Error(result.error ?? "Could not load friends.");
        if (!cancelled) {
          setData(result);
          setError(null);
        }
      } catch (caught) {
        if (!cancelled) setError(caught instanceof Error ? caught.message : "Could not load friends.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, query ? 220 : 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query]);

  async function updateProfile(discoverable: boolean) {
    setPendingId("profile");
    setError(null);
    setMessage(null);
    try {
      const response = await fetch("/api/friends", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ discoverable }),
      });
      const result = await response.json() as { discoverable?: boolean; error?: string };
      if (!response.ok) throw new Error(result.error ?? "Could not save your setting.");
      setData((current) => ({ ...current, discoverable: result.discoverable === true }));
      setMessage(discoverable ? "People can now find you by name." : "You are hidden from Friends search.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save your setting.");
    } finally {
      setPendingId(null);
    }
  }

  async function actOnFriend(friendId: string, action: "request" | "accept" | "decline" | "remove") {
    setPendingId(friendId);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch("/api/friends", {
        method: action === "request" ? "POST" : "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(action === "request" ? { friendId } : { friendId, action }),
      });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error ?? "Could not update this connection.");
      setMessage(action === "request" ? "Friend request sent." :
        action === "accept" ? "Friend request accepted." :
          action === "decline" ? "Request dismissed." : "Friend removed.");
      setQuery((current) => `${current}`);
      const refresh = await fetch(`/api/friends?q=${encodeURIComponent(query)}`, { cache: "no-store" });
      if (!refresh.ok) throw new Error("Connection changed, but the list could not refresh.");
      setData(await refresh.json() as FriendsData);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not update this connection.");
    } finally {
      setPendingId(null);
    }
  }

  function peopleList(people: FriendProfile[], mode: "search" | "friends" | "incoming" | "outgoing") {
    if (!people.length) return null;
    return (
      <ul className="friends-list">
        {people.map((person) => (
          <li className="friend-row" key={person.id}>
            <span className="friend-avatar" aria-hidden="true">
              {person.image
                ? <Image src={person.image} alt="" width={44} height={44} unoptimized />
                : initials(person.name)}
            </span>
            <div className="friend-copy">
              <strong>{person.name}</strong>
              <span>{mode === "friends" ? "Connected" : mode === "incoming" ? "Wants to connect" : mode === "outgoing" ? "Request sent" : "Between Us member"}</span>
            </div>
            {mode === "search" && (
              <button
                className="friend-action"
                type="button"
                disabled={pendingId === person.id}
                onClick={() => void actOnFriend(person.id, "request")}
                aria-label={`Send friend request to ${person.name}`}
              >
                {pendingId === person.id ? "…" : "+"}
              </button>
            )}
            {mode === "incoming" && (
              <div className="friend-row-actions">
                <button className="friend-action" type="button" disabled={pendingId === person.id} onClick={() => void actOnFriend(person.id, "accept")}>Accept</button>
                <button className="text-button" type="button" disabled={pendingId === person.id} onClick={() => void actOnFriend(person.id, "decline")}>Decline</button>
              </div>
            )}
            {mode === "friends" && (
              <button className="text-button" type="button" disabled={pendingId === person.id} onClick={() => void actOnFriend(person.id, "remove")}>Remove</button>
            )}
          </li>
        ))}
      </ul>
    );
  }

  return (
    <main className="shell trust-page social-page">
      <section className="intro social-intro">
        <p className="eyebrow">YOUR PEOPLE, YOUR MEMORIES</p>
        <h1>Friends</h1>
        <p className="lede">Find people on Between Us and invite them into a group album. A friend connection by itself never shares your posts.</p>
      </section>

      <section className="friend-discovery-setting">
        <div>
          <strong>Let others find me</strong>
          <p>Only your name and profile photo appear in search. Your email and memories stay private.</p>
        </div>
        <label className="toggle-control">
          <input
            type="checkbox"
            checked={data.discoverable}
            disabled={pendingId === "profile"}
            onChange={(event) => void updateProfile(event.target.checked)}
          />
          <span>{data.discoverable ? "On" : "Off"}</span>
        </label>
      </section>

      <label className="friend-search">
        <span aria-hidden="true">⌕</span>
        <input
          type="search"
          value={query}
          placeholder="Search by name"
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>

      {message && <p className="privacy-status" role="status">{message}</p>}
      {error && <p className="error-message" role="alert">{error}</p>}
      {data.incomingRequests.length > 0 && (
        <section className="friends-section">
          <div className="section-head"><h2>Requests for you</h2><span>{data.incomingRequests.length}</span></div>
          {peopleList(data.incomingRequests, "incoming")}
        </section>
      )}
      {data.outgoingRequests.length > 0 && (
        <section className="friends-section">
          <div className="section-head"><h2>Sent requests</h2><span>{data.outgoingRequests.length}</span></div>
          {peopleList(data.outgoingRequests, "outgoing")}
        </section>
      )}
      <section className="friends-section">
        <div className="section-head">
          <h2>{query.trim().length >= 2 ? "Search results" : "Your friends"}</h2>
          <span>{query.trim().length >= 2 ? data.results.length : data.friends.length}</span>
        </div>
        {loading ? <p className="empty-moment">Loading…</p> :
          query.trim().length >= 2
            ? peopleList(data.results, "search") ?? <p className="empty-moment">No discoverable members match that name.</p>
            : peopleList(data.friends, "friends") ?? <p className="empty-moment">No friends yet. Search for people who have chosen to be discoverable.</p>}
      </section>
    </main>
  );
}

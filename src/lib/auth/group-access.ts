import { ObjectId } from "mongodb";
import { getAuth } from "@/lib/auth";
import { getMongoDatabase } from "@/lib/db/mongodb";

export type GroupRole = "owner" | "admin" | "member";

export interface GroupMembershipIdentity {
  organizationId: string | ObjectId;
  userId: string | ObjectId;
  role: string;
}

export class GroupAccessError extends Error {
  constructor(
    public readonly status: 401 | 403 | 404,
    message: string,
  ) {
    super(message);
    this.name = "GroupAccessError";
  }
}

function normalizeId(value: string | ObjectId): string {
  return value instanceof ObjectId ? value.toHexString() : value;
}

export function mongoIdVariants(value: string): Array<string | ObjectId> {
  return ObjectId.isValid(value) ? [new ObjectId(value), value] : [value];
}

export function membershipAllows(
  membership: GroupMembershipIdentity | null,
  groupId: string,
  userId: string,
  allowedRoles?: readonly GroupRole[],
): boolean {
  if (!membership) return false;
  if (normalizeId(membership.organizationId) !== groupId) return false;
  if (normalizeId(membership.userId) !== userId) return false;
  return !allowedRoles || allowedRoles.includes(membership.role as GroupRole);
}

export function groupSummaryForMember(
  group: Record<string, unknown>,
  memberRole: GroupRole,
) {
  const id = normalizeId(group._id as string | ObjectId);
  return {
    id,
    name: typeof group.name === "string" ? group.name : "Private group",
    slug: typeof group.slug === "string" ? group.slug : id,
    description: typeof group.description === "string" ? group.description : null,
    memberRole,
  };
}

export async function listGroupsForUser(headers: Headers) {
  const auth = await getAuth();
  const session = await auth.api.getSession({ headers });
  if (!session) throw new GroupAccessError(401, "Sign in is required");

  const database = await getMongoDatabase();
  const memberships = await database
    .collection<GroupMembershipIdentity>("group_members")
    .find({ userId: { $in: mongoIdVariants(session.user.id) } })
    .toArray();
  const roleByGroup = new Map(
    memberships.map((membership) => [normalizeId(membership.organizationId), membership.role as GroupRole]),
  );
  const groupIds = [...roleByGroup.keys()]
    .filter((id) => ObjectId.isValid(id))
    .map((id) => new ObjectId(id));
  if (!groupIds.length) return [];

  const groups = await database
    .collection("groups")
    .find({ _id: { $in: groupIds }, lifecycleStatus: "active" })
    .sort({ name: 1 })
    .toArray();
  return groups.map((group) =>
    groupSummaryForMember(group, roleByGroup.get(normalizeId(group._id as string | ObjectId)) ?? "member"),
  );
}

export async function requireGroupMembership(
  headers: Headers,
  groupId: string,
  allowedRoles?: readonly GroupRole[],
  options: { allowDeletionPending?: boolean } = {},
) {
  const auth = await getAuth();
  const session = await auth.api.getSession({ headers });
  if (!session) throw new GroupAccessError(401, "Sign in is required");

  if (!ObjectId.isValid(groupId)) {
    throw new GroupAccessError(404, "Group not found");
  }

  const database = await getMongoDatabase();
  const [group, membership] = await Promise.all([
    database.collection("groups").findOne({ _id: new ObjectId(groupId) }),
    database.collection<GroupMembershipIdentity>("group_members").findOne({
      organizationId: { $in: mongoIdVariants(groupId) },
      userId: { $in: mongoIdVariants(session.user.id) },
    }),
  ]);

  if (
    !group ||
    (group.lifecycleStatus !== "active" && !options.allowDeletionPending) ||
    !membership ||
    !membershipAllows(membership, groupId, session.user.id)
  ) {
    throw new GroupAccessError(404, "Group not found");
  }
  if (allowedRoles && !allowedRoles.includes(membership.role as GroupRole)) {
    throw new GroupAccessError(403, "Group administrator permission is required");
  }

  return { session, group, membership };
}
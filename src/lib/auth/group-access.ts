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

export async function listGroupsForUser(headers: Headers) {
  const auth = await getAuth();
  const session = await auth.api.getSession({ headers });
  if (!session) throw new GroupAccessError(401, "Sign in is required");
  if (!ObjectId.isValid(session.user.id)) return [];

  const database = await getMongoDatabase();
  const memberships = await database
    .collection<GroupMembershipIdentity>("group_members")
    .find({ userId: new ObjectId(session.user.id) })
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
  return groups.map((group) => {
    const id = normalizeId(group._id as string | ObjectId);
    return {
      id,
      name: typeof group.name === "string" ? group.name : "Private group",
      slug: typeof group.slug === "string" ? group.slug : id,
      description: typeof group.description === "string" ? group.description : null,
      memberRole: roleByGroup.get(id) ?? "member",
    };
  });
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

  if (!ObjectId.isValid(groupId) || !ObjectId.isValid(session.user.id)) {
    throw new GroupAccessError(404, "Group not found");
  }

  const database = await getMongoDatabase();
  const groupObjectId = new ObjectId(groupId);
  const userObjectId = new ObjectId(session.user.id);
  const [group, membership] = await Promise.all([
    database.collection("groups").findOne({ _id: groupObjectId }),
    database.collection<GroupMembershipIdentity>("group_members").findOne({
      organizationId: groupObjectId,
      userId: userObjectId,
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
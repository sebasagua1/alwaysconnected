/**
 * RLS regression suite for SECURITY DEFINER helpers.
 *
 * Verifies:
 *  1. Anonymous clients cannot invoke is_event_participant / is_event_creator / is_group_member.
 *  2. Anonymous clients cannot read events/event_participants/groups/group_members/profiles.
 *  3. Authenticated user A:
 *      - is_event_creator(eventA, A) === true, is_event_participant(eventA, A) === true
 *      - is_group_member(groupA, A) === true
 *  4. Authenticated user B (no relationship to A's private event/group):
 *      - is_event_creator(eventA, B) === false
 *      - is_event_participant(eventA, B) === false
 *      - is_group_member(groupA, B) === false
 *      - cannot SELECT rows from A's private event_participants / group_members / groups
 *      - cannot read A's email from profiles
 *
 * Acceptance tests (three-bug fix):
 *  Issue 1 — public_profiles cross-user visibility:
 *      - B can query public_profiles and find A's row (id, name, etc.)
 *      - email column is not selectable from public_profiles
 *      - Direct SELECT on profiles for another user's row returns 0 rows
 *  Issue 2 — score/badge/checkin integrity:
 *      - Authenticated user cannot UPDATE profiles SET points=999999
 *      - Authenticated user cannot self-INSERT into badges
 *      - Participant cannot flip their own checked_in to true
 *  Issue 3 — friends event privacy:
 *      - anon cannot call are_friends
 *      - Accepted friend B CAN see A's 'friends' event
 *      - Non-friend C CANNOT see A's 'friends' event
 *
 * Requires Supabase auto-confirm email signups (default in Lovable Cloud dev).
 * If signup is rate-limited or email confirmation is enforced, the suite skips.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Proyecto DEDICADO a pruebas. Antes esta suite usaba VITE_SUPABASE_URL, o sea
// la base de PRODUCCIÓN: creaba usuarios, eventos y grupos reales, y su
// limpieza dependía de que el afterAll llegara a ejecutarse.
const URL = import.meta.env.VITE_TEST_SUPABASE_URL as string;
const ANON = import.meta.env.VITE_TEST_SUPABASE_ANON_KEY as string;

// Cinturón por si alguien apunta el proyecto de pruebas al de producción.
if (URL && URL === (import.meta.env.VITE_SUPABASE_URL as string)) {
  throw new Error(
    'VITE_TEST_SUPABASE_URL apunta al proyecto de producción. ' +
    'Esta suite crea y borra datos: usa un proyecto Supabase aparte.'
  );
}

// describe.skip y no una bandera que hace `return`: con el return, vitest
// contaba 30 tests PASADOS sin haber comprobado nada. Así salen como
// omitidos, que es la verdad.
const CONFIGURED = Boolean(URL && ANON);
const suite = CONFIGURED ? describe : describe.skip;

if (!CONFIGURED) {
  console.warn(
    '[rls-helpers] Omitida: define VITE_TEST_SUPABASE_URL y ' +
    'VITE_TEST_SUPABASE_ANON_KEY apuntando a un proyecto de pruebas.'
  );
}

const newClient = () =>
  createClient(URL, ANON, { auth: { persistSession: false, autoRefreshToken: false } });

const rand = () => Math.random().toString(36).slice(2, 10);

type Ctx = {
  anon: SupabaseClient;
  a: SupabaseClient;
  b: SupabaseClient;
  c: SupabaseClient;
  aId: string;
  bId: string;
  cId: string;
  eventId: string;           // A's private event
  openEventId: string;       // A's open event (B joins for checked_in test)
  friendsEventId: string;    // A's friends-only event
  groupId: string;
  pointTestEventId: string;  // Goal A: fresh event for join/organize point tests
  checkinEventId: string;    // Goal B: active event with lat/lng for check-in tests
};

const ctx: Partial<Ctx> = {};

async function signUp(client: SupabaseClient) {
  const email = `rls_${rand()}@example.test`;
  const password = `Pw_${rand()}${rand()}!`;
  const { data, error } = await client.auth.signUp({ email, password });
  if (error) throw error;
  if (!data.session) {
    // Email confirmation required — sign in won't work; signal skip
    throw new Error("EMAIL_CONFIRM_REQUIRED");
  }
  return data.user!.id;
}

beforeAll(async () => {
  if (!CONFIGURED) return;
  ctx.anon = newClient();
    ctx.a = newClient();
    ctx.b = newClient();
    ctx.c = newClient();
    ctx.aId = await signUp(ctx.a);
    ctx.bId = await signUp(ctx.b);
    ctx.cId = await signUp(ctx.c);

    const startsAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const endsAt = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();

    // A creates a private event
    const { data: ev, error: evErr } = await ctx.a
      .from("events")
      .insert({
        creator_id: ctx.aId,
        title: `rls-${rand()}`,
        category: "study",
        starts_at: startsAt,
        ends_at: endsAt,
        privacy: "private",
      })
      .select("id")
      .single();
    if (evErr) throw evErr;
    ctx.eventId = ev.id;

    // A joins their private event
    const { error: epErr } = await ctx.a
      .from("event_participants")
      .insert({ event_id: ctx.eventId, user_id: ctx.aId });
    if (epErr) throw epErr;

    // A creates an open event (used for Issue 2c checked_in test)
    const { data: openEv, error: openEvErr } = await ctx.a
      .from("events")
      .insert({
        creator_id: ctx.aId,
        title: `open-${rand()}`,
        category: "study",
        starts_at: startsAt,
        ends_at: endsAt,
        privacy: "open",
      })
      .select("id")
      .single();
    if (openEvErr) throw openEvErr;
    ctx.openEventId = openEv.id;

    // B joins the open event (so B has a participation row with checked_in=false)
    const { error: bJoinErr } = await ctx.b
      .from("event_participants")
      .insert({ event_id: ctx.openEventId, user_id: ctx.bId });
    if (bJoinErr) throw bJoinErr;

    // A creates a friends-only event (Issue 3)
    const { data: friendsEv, error: friendsEvErr } = await ctx.a
      .from("events")
      .insert({
        creator_id: ctx.aId,
        title: `friends-${rand()}`,
        category: "social",
        starts_at: startsAt,
        ends_at: endsAt,
        privacy: "friends",
      })
      .select("id")
      .single();
    if (friendsEvErr) throw friendsEvErr;
    ctx.friendsEventId = friendsEv.id;

    // Make A and B accepted friends the only way the app allows since
    // 20260916000000: A asks, B accepts. (Inserting status='accepted' directly
    // used to work, and was the hole that migration closes.)
    const { data: fr, error: fErr } = await ctx.a
      .from("friendships")
      .insert({ requester_id: ctx.aId, addressee_id: ctx.bId, status: "pending" })
      .select("id")
      .single();
    if (fErr) throw fErr;
    const { error: accErr } = await ctx.b
      .from("friendships")
      .update({ status: "accepted" })
      .eq("id", fr.id);
    if (accErr) throw accErr;

    // A creates a fresh open event for point-award tests (no prior participants)
    const { data: ptEv, error: ptEvErr } = await ctx.a
      .from("events")
      .insert({
        creator_id: ctx.aId,
        title: `pts-${rand()}`,
        category: "study",
        starts_at: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
        ends_at:   new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
        privacy: "open",
      })
      .select("id")
      .single();
    if (ptEvErr) throw ptEvErr;
    ctx.pointTestEventId = ptEv.id;

    // A creates an active event with TEC campus coordinates for check-in tests
    const { data: ciEv, error: ciEvErr } = await ctx.a
      .from("events")
      .insert({
        creator_id: ctx.aId,
        title: `ci-${rand()}`,
        category: "study",
        starts_at: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
        ends_at:   new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
        lat: 20.6134,
        lng: -100.4063,
        privacy: "open",
      })
      .select("id")
      .single();
    if (ciEvErr) throw ciEvErr;
    ctx.checkinEventId = ciEv.id;

    // B joins checkinEvent so B can attempt a check-in in Goal B tests
    const { error: bCiErr } = await ctx.b
      .from("event_participants")
      .insert({ event_id: ctx.checkinEventId, user_id: ctx.bId });
    if (bCiErr) throw bCiErr;

    // A creates a group and joins it
    const { data: g, error: gErr } = await ctx.a
      .from("groups")
      .insert({ created_by: ctx.aId, name: `rls-${rand()}` })
      .select("id")
      .single();
    if (gErr) throw gErr;
    ctx.groupId = g.id;
    const { error: gmErr } = await ctx.a
      .from("group_members")
      .insert({ group_id: ctx.groupId, user_id: ctx.aId });
    if (gmErr) throw gmErr;
}, 30_000);

afterAll(async () => {
  if (!CONFIGURED) return;
  try {
    // Delete private event participants then event
    if (ctx.eventId) await ctx.a!.from("event_participants").delete().eq("event_id", ctx.eventId);
    if (ctx.eventId) await ctx.a!.from("events").delete().eq("id", ctx.eventId);
    // Delete open and friends events (cascade removes participants)
    if (ctx.openEventId) await ctx.a!.from("events").delete().eq("id", ctx.openEventId);
    if (ctx.friendsEventId) await ctx.a!.from("events").delete().eq("id", ctx.friendsEventId);
    // Delete point/check-in test events (cascade removes participants;
    // point_events rows remain with event_id=NULL via ON DELETE SET NULL — harmless)
    if (ctx.pointTestEventId) await ctx.a!.from("events").delete().eq("id", ctx.pointTestEventId);
    if (ctx.checkinEventId) await ctx.a!.from("events").delete().eq("id", ctx.checkinEventId);
    // Delete group members then group
    if (ctx.groupId) await ctx.a!.from("group_members").delete().eq("group_id", ctx.groupId);
    if (ctx.groupId) await ctx.a!.from("groups").delete().eq("id", ctx.groupId);
    // Delete friendship
    if (ctx.aId && ctx.bId) {
      await ctx.a!
        .from("friendships")
        .delete()
        .eq("requester_id", ctx.aId)
        .eq("addressee_id", ctx.bId);
    }
  } catch {
    // best-effort cleanup; ignore teardown errors
  }
  await ctx.a?.auth.signOut();
  await ctx.b?.auth.signOut();
  await ctx.c?.auth.signOut();
});

// ============================================================
// Original suite — must continue to pass
// ============================================================

suite("SECURITY DEFINER helpers — anonymous access denied", () => {
  it("anon cannot RPC is_event_participant", async () => {
    const { error } = await ctx.anon!.rpc("is_event_participant", {
      _event_id: ctx.eventId!,
      _user_id: ctx.aId!,
    });
    expect(error).toBeTruthy();
  });

  it("anon cannot RPC is_event_creator", async () => {
    const { error } = await ctx.anon!.rpc("is_event_creator", {
      _event_id: ctx.eventId!,
      _user_id: ctx.aId!,
    });
    expect(error).toBeTruthy();
  });

  it("anon cannot RPC is_group_member", async () => {
    const { error } = await ctx.anon!.rpc("is_group_member", {
      _group_id: ctx.groupId!,
      _user_id: ctx.aId!,
    });
    expect(error).toBeTruthy();
  });

  it("anon SELECT on protected tables returns no rows", async () => {
    for (const table of ["events", "event_participants", "groups", "group_members", "profiles"] as const) {
      const { data, error } = await ctx.anon!.from(table).select("*").limit(1);
      // anon role has no policies → either error or empty
      expect((error ? [] : data) ?? []).toHaveLength(0);
    }
  });
});

suite("SECURITY DEFINER helpers — owner sees truth", () => {
  it("A is event creator and participant of their event", async () => {
    const { data: creator, error: e1 } = await ctx.a!.rpc("is_event_creator", {
      _event_id: ctx.eventId!,
      _user_id: ctx.aId!,
    });
    expect(e1).toBeNull();
    expect(creator).toBe(true);

    const { data: participant, error: e2 } = await ctx.a!.rpc("is_event_participant", {
      _event_id: ctx.eventId!,
      _user_id: ctx.aId!,
    });
    expect(e2).toBeNull();
    expect(participant).toBe(true);
  });

  it("A is member of their group", async () => {
    const { data, error } = await ctx.a!.rpc("is_group_member", {
      _group_id: ctx.groupId!,
      _user_id: ctx.aId!,
    });
    expect(error).toBeNull();
    expect(data).toBe(true);
  });
});

suite("SECURITY DEFINER helpers — cross-user isolation", () => {
  it("B is NOT creator/participant of A's event", async () => {
    const { data: creator } = await ctx.b!.rpc("is_event_creator", {
      _event_id: ctx.eventId!,
      _user_id: ctx.bId!,
    });
    expect(creator).toBe(false);
    const { data: participant } = await ctx.b!.rpc("is_event_participant", {
      _event_id: ctx.eventId!,
      _user_id: ctx.bId!,
    });
    expect(participant).toBe(false);
  });

  it("B is NOT a member of A's group", async () => {
    const { data } = await ctx.b!.rpc("is_group_member", {
      _group_id: ctx.groupId!,
      _user_id: ctx.bId!,
    });
    expect(data).toBe(false);
  });

  it("B cannot SELECT A's private event_participants rows", async () => {
    const { data, error } = await ctx.b!
      .from("event_participants")
      .select("*")
      .eq("event_id", ctx.eventId!);
    expect(error).toBeNull();
    expect(data ?? []).toHaveLength(0);
  });

  it("B cannot SELECT A's group or its members", async () => {
    const { data: groups } = await ctx.b!.from("groups").select("*").eq("id", ctx.groupId!);
    expect(groups ?? []).toHaveLength(0);
    const { data: members } = await ctx.b!
      .from("group_members")
      .select("*")
      .eq("group_id", ctx.groupId!);
    expect(members ?? []).toHaveLength(0);
  });

  it("B cannot read A's email from profiles", async () => {
    const { data } = await ctx.b!.from("profiles").select("email").eq("id", ctx.aId!);
    expect(data ?? []).toHaveLength(0);
  });

  it("B cannot SELECT A's private event row", async () => {
    const { data } = await ctx.b!.from("events").select("*").eq("id", ctx.eventId!);
    expect(data ?? []).toHaveLength(0);
  });
});

// ============================================================
// Issue 1 acceptance tests — public_profiles cross-user visibility
// ============================================================

suite("Issue 1 — public_profiles cross-user visibility", () => {
  it("B can read A's row from public_profiles (cross-user SELECT works)", async () => {
    const { data, error } = await ctx.b!
      .from("public_profiles")
      .select("id, name, major")
      .eq("id", ctx.aId!);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
    expect(data![0].id).toBe(ctx.aId);
  });

  it("email is not a column in public_profiles (selecting it returns an error)", async () => {
    // PostgREST returns an error when you request a column that does not exist in the view
    const { error } = await ctx.b!
      .from("public_profiles")
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .select("email" as any)
      .eq("id", ctx.aId!);
    expect(error).toBeTruthy();
  });

  it("direct SELECT on profiles for another user returns 0 rows (own-row RLS policy)", async () => {
    const { data } = await ctx.b!.from("profiles").select("id").eq("id", ctx.aId!);
    expect(data ?? []).toHaveLength(0);
  });
});

// ============================================================
// Issue 2 acceptance tests — score / badge / check-in integrity
// ============================================================

suite("Issue 2 — score / badge / check-in integrity", () => {
  it("authenticated user cannot UPDATE own points directly", async () => {
    const { error } = await ctx.a!
      .from("profiles")
      .update({ points: 999999 })
      .eq("id", ctx.aId!);
    expect(error).toBeTruthy();
  });

  it("authenticated user cannot UPDATE own reputation directly", async () => {
    const { error } = await ctx.a!
      .from("profiles")
      .update({ reputation: 9999 })
      .eq("id", ctx.aId!);
    expect(error).toBeTruthy();
  });

  it("authenticated user cannot self-insert a badge", async () => {
    const { error } = await ctx.b!
      .from("badges")
      .insert({ user_id: ctx.bId!, badge_type: "test_self_award" });
    expect(error).toBeTruthy();
  });

  it("participant cannot flip their own checked_in to true", async () => {
    // B joined ctx.openEventId in beforeAll; now B tries to self-check-in
    const { error } = await ctx.b!
      .from("event_participants")
      .update({ checked_in: true })
      .eq("event_id", ctx.openEventId!)
      .eq("user_id", ctx.bId!);
    expect(error).toBeTruthy();
  });
});

// ============================================================
// Issue 3 acceptance tests — friends event privacy
// ============================================================

suite("Issue 3 — friends event privacy", () => {
  it("anon cannot call are_friends", async () => {
    const { error } = await ctx.anon!.rpc("are_friends", { a: ctx.aId!, b: ctx.bId! });
    expect(error).toBeTruthy();
  });

  it("accepted friend B can see A's friends-only event", async () => {
    const { data, error } = await ctx.b!
      .from("events")
      .select("id, privacy")
      .eq("id", ctx.friendsEventId!);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
    expect(data![0].privacy).toBe("friends");
  });

  it("non-friend C cannot see A's friends-only event", async () => {
    const { data } = await ctx.c!
      .from("events")
      .select("id")
      .eq("id", ctx.friendsEventId!);
    expect(data ?? []).toHaveLength(0);
  });

  it("non-friend C still cannot see A's private event", async () => {
    const { data } = await ctx.c!
      .from("events")
      .select("id")
      .eq("id", ctx.eventId!);
    expect(data ?? []).toHaveLength(0);
  });
});

// ============================================================
// Goal A acceptance tests — server-side point awards
// ============================================================

suite("Goal A — server-side point awards", () => {
  it("join → point_events +10 exactly once; leave + rejoin → no second row", async () => {
    // B joins pointTestEventId for the first time
    const { error: joinErr } = await ctx.b!
      .from("event_participants")
      .insert({ event_id: ctx.pointTestEventId!, user_id: ctx.bId! });
    expect(joinErr).toBeNull();

    // Ledger has exactly one 'join' row for B + this event
    const { data: r1, error: r1Err } = await ctx.b!
      .from("point_events")
      .select("points")
      .eq("event_id", ctx.pointTestEventId!)
      .eq("reason", "join");
    expect(r1Err).toBeNull();
    expect(r1).toHaveLength(1);
    expect(r1![0].points).toBe(10);

    // B leaves
    await ctx.b!
      .from("event_participants")
      .delete()
      .eq("event_id", ctx.pointTestEventId!)
      .eq("user_id", ctx.bId!);

    // B rejoins — ON CONFLICT DO NOTHING keeps ledger idempotent
    const { error: rejoinErr } = await ctx.b!
      .from("event_participants")
      .insert({ event_id: ctx.pointTestEventId!, user_id: ctx.bId! });
    expect(rejoinErr).toBeNull();

    const { data: r2 } = await ctx.b!
      .from("point_events")
      .select("points")
      .eq("event_id", ctx.pointTestEventId!)
      .eq("reason", "join");
    expect(r2).toHaveLength(1); // still one row, not two
  });

  it("create event → point_events +25 (organize) for the creator", async () => {
    // pointTestEvent was created by A in beforeAll; the AFTER INSERT trigger
    // on events should have fired and placed an 'organize' row in the ledger
    const { data, error } = await ctx.a!
      .from("point_events")
      .select("points")
      .eq("event_id", ctx.pointTestEventId!)
      .eq("reason", "organize");
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
    expect(data![0].points).toBe(25);
  });

  it("authenticated user cannot call award_points directly (permission denied)", async () => {
    const { error } = await ctx.a!.rpc("award_points", {
      _user_id: ctx.aId!,
      _event_id: ctx.pointTestEventId!,
      _reason: "join",
      _points: 100,
    });
    expect(error).toBeTruthy();
  });

  it("authenticated UPDATE profiles SET points=999999 → still blocked (regression)", async () => {
    const { error } = await ctx.a!
      .from("profiles")
      .update({ points: 999999 })
      .eq("id", ctx.aId!);
    expect(error).toBeTruthy();
  });
});

// ============================================================
// Goal B acceptance tests — location-verified check-in
// ============================================================

suite("Goal B — location-verified check-in", () => {
  it("check_in within 150 m and inside window → checked_in=true, +15 in ledger", async () => {
    // B joined checkinEvent in beforeAll; call with exact event coordinates (0 m)
    const { data, error } = await ctx.b!.rpc("check_in_to_event", {
      _event_id: ctx.checkinEventId!,
      _lat: 20.6134,
      _lng: -100.4063,
    });
    expect(error).toBeNull();
    expect((data as { checked_in: boolean; distance_m: number }).checked_in).toBe(true);
    expect((data as { checked_in: boolean; distance_m: number }).distance_m).toBeLessThanOrEqual(150);

    const { data: rows, error: ledgerErr } = await ctx.b!
      .from("point_events")
      .select("points")
      .eq("event_id", ctx.checkinEventId!)
      .eq("reason", "check_in");
    expect(ledgerErr).toBeNull();
    expect(rows).toHaveLength(1);
    expect(rows![0].points).toBe(15);
  });

  it("second check_in call is idempotent → no extra point_events row", async () => {
    // B is already checked in from the previous test
    const { error } = await ctx.b!.rpc("check_in_to_event", {
      _event_id: ctx.checkinEventId!,
      _lat: 20.6134,
      _lng: -100.4063,
    });
    expect(error).toBeNull(); // idempotent — not an error

    const { data: rows } = await ctx.b!
      .from("point_events")
      .select("points")
      .eq("event_id", ctx.checkinEventId!)
      .eq("reason", "check_in");
    expect(rows).toHaveLength(1); // still exactly one row
  });

  it("check_in > 150 m away → TOO_FAR_FROM_EVENT, checked_in stays false, no ledger row", async () => {
    // C joins checkinEvent so they are a valid participant
    const { error: joinErr } = await ctx.c!
      .from("event_participants")
      .insert({ event_id: ctx.checkinEventId!, user_id: ctx.cId! });
    expect(joinErr).toBeNull();

    // Attempt check-in from Mexico City (~1 000 km away)
    const { error } = await ctx.c!.rpc("check_in_to_event", {
      _event_id: ctx.checkinEventId!,
      _lat: 19.4326,
      _lng: -99.1332,
    });
    expect(error).toBeTruthy();
    expect(error!.message).toContain("TOO_FAR_FROM_EVENT");

    // C must NOT be checked in
    const { data: ep } = await ctx.c!
      .from("event_participants")
      .select("checked_in")
      .eq("event_id", ctx.checkinEventId!)
      .eq("user_id", ctx.cId!);
    expect(ep).toHaveLength(1);
    expect(ep![0].checked_in).toBe(false);

    // No check_in ledger row for C
    const { data: rows } = await ctx.c!
      .from("point_events")
      .select("points")
      .eq("event_id", ctx.checkinEventId!)
      .eq("reason", "check_in");
    expect(rows ?? []).toHaveLength(0);
  });
});

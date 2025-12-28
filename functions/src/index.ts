import * as admin from "firebase-admin";
import { onCall, HttpsError } from "firebase-functions/v2/https";

admin.initializeApp();
const db = admin.firestore();

type OwnerType = "PLANT" | "FARM" | "COMPANY";

function ownerKey(orgId: string, owner: { type: OwnerType; id: string }): string {
  if (owner.type === "COMPANY") return `COMPANY_${orgId}`;
  return `${owner.type}_${owner.id}`;
}

function assertInt(n: any, fieldName: string) {
  if (typeof n !== "number" || !Number.isInteger(n) || n < 0) {
    throw new HttpsError("invalid-argument", `Field ${fieldName} must be a non-negative integer.`);
  }
}

function assertNumber(n: any, fieldName: string) {
  if (typeof n !== "number" || !isFinite(n) || n < 0) {
    throw new HttpsError("invalid-argument", `Field ${fieldName} must be a non-negative number.`);
  }
}

async function getUser(orgId: string, uid: string) {
  const ref = db.doc(`orgs/${orgId}/users/${uid}`);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError("permission-denied", "User not registered in org.");
  return snap.data() as any;
}

async function nextDocNoTx(
  tx: FirebaseFirestore.Transaction,
  orgId: string,
  counterName: string,
  prefix: string,
  yyyymmdd: string
): Promise<string> {
  const counterRef = db.doc(`orgs/${orgId}/counters/${counterName}`);
  const counterSnap = await tx.get(counterRef);

  const current = counterSnap.exists ? (counterSnap.data()?.value ?? 0) : 0;
  const next = current + 1;
  tx.set(counterRef, { value: next, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });

  const seq = String(next).padStart(4, "0");
  return `${prefix}-${yyyymmdd}-${seq}`;
}

function todayYYYYMMDD(): string {
  const d = new Date();
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}${mm}${dd}`;
}

/**
 * Packaging Transfer POST:
 * - Generates docNo
 * - Updates packagingBalances for fromOwner and toOwner
 * - Locks transfer as POSTED
 */
export const postPackagingTransfer = onCall(async (req) => {
  if (!req.auth) throw new HttpsError("unauthenticated", "Login required.");

  const { orgId, docId } = req.data || {};
  if (!orgId || !docId) throw new HttpsError("invalid-argument", "orgId and docId are required.");

  const user = await getUser(orgId, req.auth.uid);
  const role = user.role as string;
  if (!["admin", "ops_manager", "warehouse", "accounting"].includes(role)) {
    throw new HttpsError("permission-denied", "Insufficient role.");
  }

  const transferRef = db.doc(`orgs/${orgId}/packagingTransfers/${docId}`);
  const yyyymmdd = todayYYYYMMDD();

  await db.runTransaction(async (tx) => {
    const transferSnap = await tx.get(transferRef);
    if (!transferSnap.exists) throw new HttpsError("not-found", "Transfer document not found.");

    const t = transferSnap.data() as any;

    if (t.status !== "DRAFT") throw new HttpsError("failed-precondition", "Only DRAFT can be posted.");
    if (t.docNo) throw new HttpsError("failed-precondition", "docNo already set.");

    const fromOwner = t.fromOwner as { type: OwnerType; id: string };
    const toOwner = t.toOwner as { type: OwnerType; id: string };
    const items = t.items as Array<{ packType: string; qty: number }>;

    if (!fromOwner || !toOwner || !Array.isArray(items) || items.length === 0) {
      throw new HttpsError("invalid-argument", "Invalid transfer payload.");
    }

    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (!it.packType) throw new HttpsError("invalid-argument", "packType required.");
      assertInt(it.qty, `items[${i}].qty`);
    }

    const docNo = await nextDocNoTx(tx, orgId, `PKG_${yyyymmdd}`, "PKG", yyyymmdd);

    const fromKey = ownerKey(orgId, fromOwner);
    const toKey = ownerKey(orgId, toOwner);

    const fromBalRef = db.doc(`orgs/${orgId}/packagingBalances/${fromKey}`);
    const toBalRef = db.doc(`orgs/${orgId}/packagingBalances/${toKey}`);

    const fromBalSnap = await tx.get(fromBalRef);
    const toBalSnap = await tx.get(toBalRef);

    const fromBal = (fromBalSnap.exists ? fromBalSnap.data() : null) as any;
    const toBal = (toBalSnap.exists ? toBalSnap.data() : null) as any;

    const fromBalances: Record<string, number> = fromBal?.balances || {};
    const toBalances: Record<string, number> = toBal?.balances || {};

    for (const it of items) {
      const k = it.packType;
      const q = it.qty;

      const fromCurrent = Number(fromBalances[k] || 0);
      const toCurrent = Number(toBalances[k] || 0);

      if (fromCurrent - q < 0) {
        throw new HttpsError(
          "failed-precondition",
          `Insufficient balance for ${k} on ${fromKey}. Current=${fromCurrent}, required=${q}.`
        );
      }

      fromBalances[k] = fromCurrent - q;
      toBalances[k] = toCurrent + q;
    }

    tx.set(
      fromBalRef,
      { owner: fromOwner, balances: fromBalances, updatedAt: admin.firestore.FieldValue.serverTimestamp() },
      { merge: true }
    );
    tx.set(
      toBalRef,
      { owner: toOwner, balances: toBalances, updatedAt: admin.firestore.FieldValue.serverTimestamp() },
      { merge: true }
    );

    tx.update(transferRef, {
      docNo,
      status: "POSTED",
      postedAt: admin.firestore.FieldValue.serverTimestamp(),
      postedBy: req.auth!.uid
    });
  });

  return { ok: true };
});

/**
 * Inbound Receipt POST:
 * - Generates receiptNo
 * - Creates receiptBalances/{receiptId}: { remainingKg }
 * - Locks receipt as APPROVED
 */
export const postInboundReceipt = onCall(async (req) => {
  if (!req.auth) throw new HttpsError("unauthenticated", "Login required.");

  const { orgId, receiptId } = req.data || {};
  if (!orgId || !receiptId) throw new HttpsError("invalid-argument", "orgId and receiptId are required.");

  const user = await getUser(orgId, req.auth.uid);
  const role = user.role as string;
  if (!["admin", "ops_manager", "warehouse", "accounting"].includes(role)) {
    throw new HttpsError("permission-denied", "Insufficient role.");
  }

  const receiptRef = db.doc(`orgs/${orgId}/inboundReceipts/${receiptId}`);
  const balRef = db.doc(`orgs/${orgId}/receiptBalances/${receiptId}`);
  const yyyymmdd = todayYYYYMMDD();

  await db.runTransaction(async (tx) => {
    const rSnap = await tx.get(receiptRef);
    if (!rSnap.exists) throw new HttpsError("not-found", "Receipt not found.");

    const r = rSnap.data() as any;
    if (r.status !== "DRAFT") throw new HttpsError("failed-precondition", "Only DRAFT can be posted.");
    if (r.receiptNo) throw new HttpsError("failed-precondition", "receiptNo already set.");

    if (!r.farmId) throw new HttpsError("invalid-argument", "farmId required.");
    assertNumber(r.qtyKg, "qtyKg");

    const receiptNo = await nextDocNoTx(tx, orgId, `IR_${yyyymmdd}`, "IR", yyyymmdd);

    // Create/overwrite balance
    tx.set(balRef, {
      receiptId,
      remainingKg: r.qtyKg,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    tx.update(receiptRef, {
      receiptNo,
      status: "APPROVED",
      approvedAt: admin.firestore.FieldValue.serverTimestamp(),
      approvedBy: req.auth!.uid
    });
  });

  return { ok: true };
});

/**
 * Shipment POST:
 * - Generates shipmentNo
 * - Deducts from receiptBalances based on shipment.lines
 * - Locks shipment as LOADED
 */
export const postShipment = onCall(async (req) => {
  if (!req.auth) throw new HttpsError("unauthenticated", "Login required.");

  const { orgId, shipmentId } = req.data || {};
  if (!orgId || !shipmentId) throw new HttpsError("invalid-argument", "orgId and shipmentId are required.");

  const user = await getUser(orgId, req.auth.uid);
  const role = user.role as string;
  if (!["admin", "ops_manager", "warehouse"].includes(role)) {
    throw new HttpsError("permission-denied", "Insufficient role.");
  }

  const shipmentRef = db.doc(`orgs/${orgId}/shipments/${shipmentId}`);
  const yyyymmdd = todayYYYYMMDD();

  await db.runTransaction(async (tx) => {
    const sSnap = await tx.get(shipmentRef);
    if (!sSnap.exists) throw new HttpsError("not-found", "Shipment not found.");

    const s = sSnap.data() as any;
    if (s.status !== "DRAFT") throw new HttpsError("failed-precondition", "Only DRAFT can be posted.");
    if (s.shipmentNo) throw new HttpsError("failed-precondition", "shipmentNo already set.");

    const lines = s.lines as Array<{ receiptId: string; qtyKg: number }>;
    if (!Array.isArray(lines) || lines.length === 0) {
      throw new HttpsError("invalid-argument", "Shipment lines required.");
    }

    // Validate and deduct balances
    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i];
      if (!ln.receiptId) throw new HttpsError("invalid-argument", "receiptId required in lines.");
      assertNumber(ln.qtyKg, `lines[${i}].qtyKg`);

      const balRef = db.doc(`orgs/${orgId}/receiptBalances/${ln.receiptId}`);
      const balSnap = await tx.get(balRef);
      if (!balSnap.exists) throw new HttpsError("failed-precondition", `Receipt balance missing: ${ln.receiptId}`);

      const remaining = Number((balSnap.data() as any).remainingKg || 0);
      if (remaining - ln.qtyKg < 0) {
        throw new HttpsError(
          "failed-precondition",
          `Insufficient remaining for receipt ${ln.receiptId}. Remaining=${remaining}, required=${ln.qtyKg}`
        );
      }

      tx.update(balRef, {
        remainingKg: remaining - ln.qtyKg,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
    }

    const shipmentNo = await nextDocNoTx(tx, orgId, `SHP_${yyyymmdd}`, "SHP", yyyymmdd);

    tx.update(shipmentRef, {
      shipmentNo,
      status: "LOADED",
      loadedAt: admin.firestore.FieldValue.serverTimestamp(),
      loadedBy: req.auth!.uid
    });
  });

  return { ok: true };
});

/**
 * Carton Purchase POST:
 * - Increments cartonBalances per item
 * - Locks purchase as POSTED
 */
export const postCartonPurchase = onCall(async (req) => {
  if (!req.auth) throw new HttpsError("unauthenticated", "Login required.");

  const { orgId, purchaseId } = req.data || {};
  if (!orgId || !purchaseId) throw new HttpsError("invalid-argument", "orgId and purchaseId are required.");

  const user = await getUser(orgId, req.auth.uid);
  const role = user.role as string;
  if (!["admin", "warehouse", "accounting"].includes(role)) {
    throw new HttpsError("permission-denied", "Insufficient role.");
  }

  const ref = db.doc(`orgs/${orgId}/cartonPurchases/${purchaseId}`);
  const yyyymmdd = todayYYYYMMDD();

  await db.runTransaction(async (tx) => {
    const pSnap = await tx.get(ref);
    if (!pSnap.exists) throw new HttpsError("not-found", "Purchase not found.");

    const p = pSnap.data() as any;
    if (p.status !== "DRAFT") throw new HttpsError("failed-precondition", "Only DRAFT can be posted.");

    const items = p.items as Array<{ itemId: string; qty: number }>;
    if (!Array.isArray(items) || items.length === 0) throw new HttpsError("invalid-argument", "items required.");

    for (let i=0;i<items.length;i++){
      const it = items[i];
      if (!it.itemId) throw new HttpsError("invalid-argument", "itemId required.");
      assertInt(it.qty, `items[${i}].qty`);

      const balRef = db.doc(`orgs/${orgId}/cartonBalances/${it.itemId}`);
      const balSnap = await tx.get(balRef);
      const cur = balSnap.exists ? Number((balSnap.data() as any).qty || 0) : 0;
      tx.set(balRef, { itemId: it.itemId, qty: cur + it.qty, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    }

    const docNo = await nextDocNoTx(tx, orgId, `CP_${yyyymmdd}`, "CP", yyyymmdd);
    tx.update(ref, { purchaseNo: docNo, status: "POSTED", postedAt: admin.firestore.FieldValue.serverTimestamp(), postedBy: req.auth!.uid });
  });

  return { ok: true };
});

/**
 * Carton Issue POST:
 * - Decrements cartonBalances per item
 * - Locks issue as POSTED
 */
export const postCartonIssue = onCall(async (req) => {
  if (!req.auth) throw new HttpsError("unauthenticated", "Login required.");

  const { orgId, issueId } = req.data || {};
  if (!orgId || !issueId) throw new HttpsError("invalid-argument", "orgId and issueId are required.");

  const user = await getUser(orgId, req.auth.uid);
  const role = user.role as string;
  if (!["admin", "warehouse", "ops_manager"].includes(role)) {
    throw new HttpsError("permission-denied", "Insufficient role.");
  }

  const ref = db.doc(`orgs/${orgId}/cartonIssues/${issueId}`);
  const yyyymmdd = todayYYYYMMDD();

  await db.runTransaction(async (tx) => {
    const iSnap = await tx.get(ref);
    if (!iSnap.exists) throw new HttpsError("not-found", "Issue not found.");

    const doc = iSnap.data() as any;
    if (doc.status !== "DRAFT") throw new HttpsError("failed-precondition", "Only DRAFT can be posted.");

    const items = doc.items as Array<{ itemId: string; qty: number }>;
    if (!Array.isArray(items) || items.length === 0) throw new HttpsError("invalid-argument", "items required.");

    for (let idx=0; idx<items.length; idx++){
      const it = items[idx];
      if (!it.itemId) throw new HttpsError("invalid-argument", "itemId required.");
      assertInt(it.qty, `items[${idx}].qty`);

      const balRef = db.doc(`orgs/${orgId}/cartonBalances/${it.itemId}`);
      const balSnap = await tx.get(balRef);
      const cur = balSnap.exists ? Number((balSnap.data() as any).qty || 0) : 0;
      if (cur - it.qty < 0) {
        throw new HttpsError("failed-precondition", `Insufficient carton balance for ${it.itemId}. Current=${cur}, required=${it.qty}`);
      }
      tx.set(balRef, { itemId: it.itemId, qty: cur - it.qty, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    }

    const docNo = await nextDocNoTx(tx, orgId, `CI_${yyyymmdd}`, "CI", yyyymmdd);
    tx.update(ref, { issueNo: docNo, status: "POSTED", postedAt: admin.firestore.FieldValue.serverTimestamp(), postedBy: req.auth!.uid });
  });

  return { ok: true };
});

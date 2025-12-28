import React, { useEffect, useMemo, useState } from "react";
import { onAuthStateChanged, signInWithEmailAndPassword, signOut } from "firebase/auth";
import { httpsCallable } from "firebase/functions";
import { addDoc, collection, doc, getDoc, getDocs, query, serverTimestamp, where } from "firebase/firestore";
import { auth, db, functions } from "./firebase";

type Role = "admin" | "ops_manager" | "warehouse" | "accounting" | "field";
type UserProfile = { orgId: string; role: Role; status: string; name?: string };

const ORG_ID = "main"; // غيّرها لو orgId مختلف عندكم

export default function App() {
  const [user, setUser] = useState<any>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  useEffect(() => {
    return onAuthStateChanged(auth, async (u) => {
      setUser(u);
      setProfile(null);
      if (u) {
        const pRef = doc(db, `orgs/${ORG_ID}/users/${u.uid}`);
        const pSnap = await getDoc(pRef);
        if (pSnap.exists()) setProfile(pSnap.data() as any);
      }
    });
  }, []);

  const can = useMemo(() => {
    const r = profile?.role;
    return {
      postInbound: r === "admin" || r === "ops_manager" || r === "warehouse" || r === "accounting",
      postPkg: r === "admin" || r === "ops_manager" || r === "warehouse" || r === "accounting",
      postShip: r === "admin" || r === "ops_manager" || r === "warehouse",
      postCarton: r === "admin" || r === "warehouse" || r === "accounting",
    };
  }, [profile]);

  async function login() {
    await signInWithEmailAndPassword(auth, email, password);
  }

  if (!user) {
    return (
      <div style={{ fontFamily: "system-ui", maxWidth: 420, margin: "40px auto" }}>
        <h2>SupplySys</h2>
        <p>تسجيل الدخول</p>
        <input placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} style={{ width: "100%", padding: 10, marginBottom: 10 }} />
        <input placeholder="Password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} style={{ width: "100%", padding: 10, marginBottom: 10 }} />
        <button onClick={login} style={{ width: "100%", padding: 10 }}>دخول</button>
      </div>
    );
  }

  return (
    <div style={{ fontFamily: "system-ui", maxWidth: 1000, margin: "20px auto" }}>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <h2 style={{ margin: 0 }}>SupplySys</h2>
          <small>Org: {ORG_ID} | Role: {profile?.role || "?"}</small>
        </div>
        <button onClick={() => signOut(auth)} style={{ padding: 8 }}>خروج</button>
      </header>

      <hr />

      <section style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <Card title="إيصال استلام كميات (DRAFT → APPROVED)">
          <InboundReceiptForm disabled={!can.postInbound} orgId={ORG_ID} />
        </Card>

        <Card title="حركة عبوات (DRAFT → POSTED)">
          <PackagingTransferForm disabled={!can.postPkg} orgId={ORG_ID} />
        </Card>

        <Card title="أمر شحن/تحميل (DRAFT → LOADED)">
          <ShipmentForm disabled={!can.postShip} orgId={ORG_ID} />
        </Card>

        <Card title="كرتون: شراء + صرف (DRAFT → POSTED)">
          <CartonForms disabled={!can.postCarton} orgId={ORG_ID} />
        </Card>
      </section>
    </div>
  );
}

function Card({ title, children }: any) {
  return (
    <div style={{ border: "1px solid #ddd", borderRadius: 10, padding: 14 }}>
      <h3 style={{ marginTop: 0 }}>{title}</h3>
      {children}
    </div>
  );
}

function InboundReceiptForm({ orgId, disabled }: { orgId: string; disabled: boolean }) {
  const [farmId, setFarmId] = useState("");
  const [grade, setGrade] = useState("A");
  const [qtyKg, setQtyKg] = useState(0);
  const [msg, setMsg] = useState("");

  async function createAndPost() {
    setMsg("");
    const col = collection(db, `orgs/${orgId}/inboundReceipts`);
    const docRef = await addDoc(col, {
      status: "DRAFT",
      farmId,
      grade,
      qtyKg: Number(qtyKg),
      date: new Date().toISOString().slice(0,10),
      createdAt: serverTimestamp(),
      createdBy: auth.currentUser?.uid
    });
    const fn = httpsCallable(functions, "postInboundReceipt");
    await fn({ orgId, receiptId: docRef.id });
    setMsg("تم اعتماد الإيصال بنجاح.");
  }

  return (
    <div>
      <input placeholder="farmId (مثال: farm1)" value={farmId} onChange={(e) => setFarmId(e.target.value)} style={{ width: "100%", padding: 8, marginBottom: 8 }} />
      <select value={grade} onChange={(e)=>setGrade(e.target.value)} style={{ width: "100%", padding: 8, marginBottom: 8 }}>
        <option value="A">A</option>
        <option value="B">B</option>
        <option value="IND">صناعي</option>
      </select>
      <input type="number" placeholder="الكمية كجم" value={qtyKg} onChange={(e)=>setQtyKg(Number(e.target.value))} style={{ width: "100%", padding: 8, marginBottom: 8 }} />
      <button disabled={disabled} onClick={createAndPost} style={{ width: "100%", padding: 10 }}>إنشاء + اعتماد</button>
      <small style={{ display: "block", marginTop: 8 }}>{msg}</small>
    </div>
  );
}

function PackagingTransferForm({ orgId, disabled }: { orgId: string; disabled: boolean }) {
  const [moveType, setMoveType] = useState("PLANT_TO_COMPANY");
  const [fromType, setFromType] = useState<OwnerType>("PLANT");
  const [fromId, setFromId] = useState("plant1");
  const [toType, setToType] = useState<OwnerType>("COMPANY");
  const [toId, setToId] = useState(orgId);
  const [plt, setPlt] = useState(0);
  const [brn, setBrn] = useState(0);
  const [msg, setMsg] = useState("");

  async function createAndPost() {
    setMsg("");
    const col = collection(db, `orgs/${orgId}/packagingTransfers`);
    const docRef = await addDoc(col, {
      status: "DRAFT",
      moveType,
      fromOwner: { type: fromType, id: fromId },
      toOwner: { type: toType, id: toId },
      items: [
        { packType: "PLT", qty: Number(plt) },
        { packType: "BRN", qty: Number(brn) }
      ].filter(x => x.qty > 0),
      createdAt: serverTimestamp(),
      createdBy: auth.currentUser?.uid
    });
    const fn = httpsCallable(functions, "postPackagingTransfer");
    await fn({ orgId, docId: docRef.id });
    setMsg("تم ترحيل حركة العبوات بنجاح.");
  }

  return (
    <div>
      <select value={moveType} onChange={(e)=>setMoveType(e.target.value)} style={{ width: "100%", padding: 8, marginBottom: 8 }}>
        <option value="PLANT_TO_COMPANY">استلام من المصنع → الشركة</option>
        <option value="COMPANY_TO_FARM">صرف من الشركة → مزرعة</option>
        <option value="FARM_TO_COMPANY">استلام من مزرعة → الشركة</option>
        <option value="COMPANY_TO_PLANT">رد من الشركة → المصنع</option>
      </select>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
        <div>
          <small>من</small>
          <select value={fromType} onChange={(e)=>setFromType(e.target.value as any)} style={{ width: "100%", padding: 8, marginBottom: 6 }}>
            <option value="PLANT">مصنع</option>
            <option value="FARM">مزرعة</option>
            <option value="COMPANY">شركة</option>
          </select>
          <input value={fromId} onChange={(e)=>setFromId(e.target.value)} style={{ width: "100%", padding: 8 }} />
        </div>
        <div>
          <small>إلى</small>
          <select value={toType} onChange={(e)=>setToType(e.target.value as any)} style={{ width: "100%", padding: 8, marginBottom: 6 }}>
            <option value="COMPANY">شركة</option>
            <option value="FARM">مزرعة</option>
            <option value="PLANT">مصنع</option>
          </select>
          <input value={toId} onChange={(e)=>setToId(e.target.value)} style={{ width: "100%", padding: 8 }} />
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 8 }}>
        <input type="number" placeholder="PLT (بالت)" value={plt} onChange={(e)=>setPlt(Number(e.target.value))} style={{ width: "100%", padding: 8 }} />
        <input type="number" placeholder="BRN (برانيك)" value={brn} onChange={(e)=>setBrn(Number(e.target.value))} style={{ width: "100%", padding: 8 }} />
      </div>

      <button disabled={disabled} onClick={createAndPost} style={{ width: "100%", padding: 10, marginTop: 8 }}>إنشاء + ترحيل</button>
      <small style={{ display: "block", marginTop: 8 }}>{msg}</small>
    </div>
  );
}

type OwnerType = "PLANT" | "FARM" | "COMPANY";

function ShipmentForm({ orgId, disabled }: { orgId: string; disabled: boolean }) {
  const [truckId, setTruckId] = useState("truck1");
  const [destination, setDestination] = useState("");
  const [receiptId, setReceiptId] = useState("");
  const [qtyKg, setQtyKg] = useState(0);
  const [msg, setMsg] = useState("");

  async function createAndPost() {
    setMsg("");
    const col = collection(db, `orgs/${orgId}/shipments`);
    const docRef = await addDoc(col, {
      status: "DRAFT",
      truckId,
      destination,
      loadDateTime: new Date().toISOString(),
      lines: [{ receiptId, qtyKg: Number(qtyKg) }],
      createdAt: serverTimestamp(),
      createdBy: auth.currentUser?.uid
    });
    const fn = httpsCallable(functions, "postShipment");
    await fn({ orgId, shipmentId: docRef.id });
    setMsg("تم ترحيل الشحنة إلى LOADED.");
  }

  return (
    <div>
      <input placeholder="truckId (مثال: truck1)" value={truckId} onChange={(e)=>setTruckId(e.target.value)} style={{ width: "100%", padding: 8, marginBottom: 8 }} />
      <input placeholder="الوجهة" value={destination} onChange={(e)=>setDestination(e.target.value)} style={{ width: "100%", padding: 8, marginBottom: 8 }} />
      <input placeholder="receiptId (من إيصال الاستلام)" value={receiptId} onChange={(e)=>setReceiptId(e.target.value)} style={{ width: "100%", padding: 8, marginBottom: 8 }} />
      <input type="number" placeholder="كمية التحميل كجم" value={qtyKg} onChange={(e)=>setQtyKg(Number(e.target.value))} style={{ width: "100%", padding: 8, marginBottom: 8 }} />
      <button disabled={disabled} onClick={createAndPost} style={{ width: "100%", padding: 10 }}>إنشاء + ترحيل</button>
      <small style={{ display: "block", marginTop: 8 }}>{msg}</small>
    </div>
  );
}

function CartonForms({ orgId, disabled }: { orgId: string; disabled: boolean }) {
  const [itemId, setItemId] = useState("carton1");
  const [qty, setQty] = useState(0);
  const [msg, setMsg] = useState("");

  async function purchase() {
    setMsg("");
    const col = collection(db, `orgs/${orgId}/cartonPurchases`);
    const docRef = await addDoc(col, { status: "DRAFT", date: new Date().toISOString().slice(0,10), items: [{ itemId, qty: Number(qty) }], createdAt: serverTimestamp(), createdBy: auth.currentUser?.uid });
    const fn = httpsCallable(functions, "postCartonPurchase");
    await fn({ orgId, purchaseId: docRef.id });
    setMsg("تم ترحيل شراء الكرتون.");
  }

  async function issue() {
    setMsg("");
    const col = collection(db, `orgs/${orgId}/cartonIssues`);
    const docRef = await addDoc(col, { status: "DRAFT", date: new Date().toISOString().slice(0,10), items: [{ itemId, qty: Number(qty) }], createdAt: serverTimestamp(), createdBy: auth.currentUser?.uid });
    const fn = httpsCallable(functions, "postCartonIssue");
    await fn({ orgId, issueId: docRef.id });
    setMsg("تم ترحيل صرف الكرتون.");
  }

  return (
    <div>
      <input placeholder="itemId (مثال: carton1)" value={itemId} onChange={(e)=>setItemId(e.target.value)} style={{ width: "100%", padding: 8, marginBottom: 8 }} />
      <input type="number" placeholder="الكمية" value={qty} onChange={(e)=>setQty(Number(e.target.value))} style={{ width: "100%", padding: 8, marginBottom: 8 }} />
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
        <button disabled={disabled} onClick={purchase} style={{ padding: 10 }}>شراء</button>
        <button disabled={disabled} onClick={issue} style={{ padding: 10 }}>صرف</button>
      </div>
      <small style={{ display: "block", marginTop: 8 }}>{msg}</small>
    </div>
  );
}

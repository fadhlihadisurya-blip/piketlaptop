import { initializeApp } from 'firebase/app';
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  onAuthStateChanged,
  User,
} from 'firebase/auth';
import {
  getFirestore,
  doc,
  getDoc,
  getDocFromServer,
  getDocs,
  setDoc,
  updateDoc,
  deleteDoc,
  collection,
  query,
  where,
  onSnapshot,
  serverTimestamp,
  writeBatch,
  Unsubscribe,
} from 'firebase/firestore';
import firebaseConfig from '../firebase-applet-config.json';

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);
export const auth = getAuth(app);

const SCHOOL_CODE = 'ASSYIFA-WRJ';
const BOOTSTRAP_ADMIN_EMAIL = 'fadhlihadisurya@gmail.com';
const VALID_ID_REGEX = /^[a-zA-Z0-9_\-]+$/;

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

export function handleFirestoreError(
  error: unknown,
  operationType: OperationType,
  path: string | null
): never {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo:
        auth.currentUser?.providerData?.map((provider) => ({
          providerId: provider.providerId,
          email: provider.email,
        })) || [],
    },
    operationType,
    path,
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

async function testConnection() {
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
  } catch (error) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.error('Please check your Firebase configuration.');
    }
  }
}
testConnection();

export interface CloudUser {
  id: string;
  uid: string;
  email: string;
  fullName: string;
  role: 'admin' | 'piket';
  isBootstrapAdmin: boolean;
}

export interface StudentRecord {
  nis: string;
  nama: string;
  kelas: string;
  foto: string;
  laptopCode: string;
  laptopBrand: string;
  laptopStatus: 'tersedia' | 'dibawa';
  blocked: boolean;
  blockReason: string;
  lastActivityAt: string;
  lastHandledBy: string;
  schoolCode?: string;
  updatedByUid?: string;
}

export interface CirculationLogRecord {
  id: string;
  dateKey: string;
  nis: string;
  nama: string;
  kelas: string;
  laptopCode: string;
  waktuAmbil: string;
  waktuKembali: string;
  petugasAmbil: string;
  petugasKembali: string;
  status: 'Dibawa Murid' | 'Selesai Kembali';
  schoolCode?: string;
  handledByUid?: string;
}

export interface StaffRoleRecord {
  id: string;
  email: string;
  fullName: string;
  role: 'admin' | 'piket';
  assignedByUid: string;
}

export interface ClassRecord {
  id: string;
  name: string;
}

type StateListener = () => void;
type AuthListener = (user: CloudUser | null, isReady: boolean) => void;

const cloudCache = {
  isReady: false,
  classesLoaded: false,
  user: null as CloudUser | null,
  students: [] as StudentRecord[],
  classes: [] as ClassRecord[],
  logs: [] as CirculationLogRecord[],
  staffRoles: [] as StaffRoleRecord[],
  registeredUsers: [] as { uid: string; fullName: string; role: 'admin' | 'piket' }[],
};

let unsubscribers: Unsubscribe[] = [];
const stateListeners = new Set<StateListener>();
const authListeners = new Set<AuthListener>();

function notifyStateListeners() {
  stateListeners.forEach((fn) => {
    try {
      fn();
    } catch (err) {
      console.error('Error in state listener:', err);
    }
  });
}

function notifyAuthListeners() {
  authListeners.forEach((fn) => {
    try {
      fn(cloudCache.user, cloudCache.isReady);
    } catch (err) {
      console.error('Error in auth listener:', err);
    }
  });
}

function clearSubscriptions() {
  unsubscribers.forEach((unsub) => {
    try {
      unsub();
    } catch {
      // ignore
    }
  });
  unsubscribers = [];
  cloudCache.classesLoaded = false;
  cloudCache.students = [];
  cloudCache.classes = [];
  cloudCache.logs = [];
  cloudCache.staffRoles = [];
  cloudCache.registeredUsers = [];
}

function clampStr(val: unknown, maxLen: number): string {
  return String(val ?? '').trim().slice(0, maxLen);
}

function assertValidId(val: string, fieldName: string, maxLen = 128) {
  if (!val || val.length > maxLen || !VALID_ID_REGEX.test(val)) {
    throw new Error(
      `${fieldName} hanya boleh berisi huruf, angka, tanda hubung (-), atau garis bawah (_) tanpa spasi (1–${maxLen} karakter).`
    );
  }
}

function makeSafeClassId(name: string): string {
  const slug = name
    .trim()
    .replace(/[^a-zA-Z0-9_\-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug ? `cls-${slug}` : `cls-${Date.now()}`;
}

function makeSafeRoleId(email: string): string {
  const slug = email
    .trim()
    .toLowerCase()
    .replace(/[^a-zA-Z0-9_\-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return slug ? `role-${slug}` : `role-${Date.now()}`;
}

async function resolveAndBootstrapUser(firebaseUser: User): Promise<CloudUser> {
  const uid = firebaseUser.uid;
  const emailLower = (firebaseUser.email || '').trim().toLowerCase();
  const isBootstrap = emailLower === BOOTSTRAP_ADMIN_EMAIL;

  // 1. Cek apakah user memiliki dokumen di /admins/{uid}
  let hasAdminMarker = false;
  try {
    const adminSnap = await getDoc(doc(db, 'admins', uid));
    hasAdminMarker = adminSnap.exists();
  } catch (error) {
    handleFirestoreError(error, OperationType.GET, `admins/${uid}`);
  }

  // 2. Cek apakah email staf terdaftar di /staff_roles (query sesuai rule list)
  let assignedStaffRole: StaffRoleRecord | null = null;
  if (emailLower) {
    try {
      const roleQuery = query(collection(db, 'staff_roles'), where('email', '==', emailLower));
      const roleSnap = await getDocs(roleQuery);
      if (!roleSnap.empty) {
        const d = roleSnap.docs[0];
        const data = d.data();
        assignedStaffRole = {
          id: d.id,
          email: String(data.email || emailLower),
          fullName: String(data.fullName || ''),
          role: data.role === 'admin' ? 'admin' : 'piket',
          assignedByUid: String(data.assignedByUid || ''),
        };
      }
    } catch (error) {
      handleFirestoreError(error, OperationType.LIST, 'staff_roles');
    }
  }

  // 3. Jika Bootstrap Admin dan belum memiliki dokumen /admins/{uid}, buat penanda admin
  if (isBootstrap && !hasAdminMarker) {
    try {
      await setDoc(doc(db, 'admins', uid), {
        uid,
        grantedByUid: uid,
        createdAt: serverTimestamp(),
      });
      hasAdminMarker = true;
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, `admins/${uid}`);
    }
  }

  // 4. Cek dokumen /users/{uid}
  let existingUserData: { fullName?: string; role?: string } | null = null;
  try {
    const userSnap = await getDoc(doc(db, 'users', uid));
    if (userSnap.exists()) {
      existingUserData = userSnap.data() as { fullName?: string; role?: string };
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.GET, `users/${uid}`);
  }

  const displayName = clampStr(
    assignedStaffRole?.fullName ||
      existingUserData?.fullName ||
      firebaseUser.displayName ||
      emailLower ||
      'Petugas Sekolah',
    120
  );

  let effectiveRole: 'admin' | 'piket' = 'piket';
  if (isBootstrap || hasAdminMarker || existingUserData?.role === 'admin') {
    effectiveRole = 'admin';
  }

  // 5. Pastikan dokumen /users/{uid} ada dan sinkron (tanpa menyimpan PII email)
  if (!existingUserData) {
    const createRole: 'admin' | 'piket' = isBootstrap || hasAdminMarker ? 'admin' : 'piket';
    try {
      await setDoc(doc(db, 'users', uid), {
        uid,
        fullName: displayName,
        role: createRole,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      effectiveRole = createRole;
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, `users/${uid}`);
    }
  } else if (isBootstrap && existingUserData.role !== 'admin') {
    try {
      await updateDoc(doc(db, 'users', uid), {
        role: 'admin',
        updatedAt: serverTimestamp(),
      });
      effectiveRole = 'admin';
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, `users/${uid}`);
    }
  }

  return {
    id: uid,
    uid,
    email: emailLower,
    fullName: displayName,
    role: effectiveRole,
    isBootstrapAdmin: isBootstrap,
  };
}

function attachFirestoreListeners(user: CloudUser) {
  clearSubscriptions();

  // 1. Students listener
  const studentsQuery = query(
    collection(db, 'students'),
    where('schoolCode', '==', SCHOOL_CODE)
  );
  unsubscribers.push(
    onSnapshot(
      studentsQuery,
      (snapshot) => {
        const list: StudentRecord[] = snapshot.docs.map((d) => {
          const data = d.data();
          return {
            nis: String(data.nis || d.id),
            nama: String(data.nama || ''),
            kelas: String(data.kelas || ''),
            foto: String(data.foto || ''),
            laptopCode: String(data.laptopCode || ''),
            laptopBrand: String(data.laptopBrand || ''),
            laptopStatus: data.laptopStatus === 'dibawa' ? 'dibawa' : 'tersedia',
            blocked: Boolean(data.blocked),
            blockReason: String(data.blockReason || ''),
            lastActivityAt: String(data.lastActivityAt || ''),
            lastHandledBy: String(data.lastHandledBy || ''),
            schoolCode: String(data.schoolCode || SCHOOL_CODE),
            updatedByUid: String(data.updatedByUid || ''),
          };
        });
        list.sort((a, b) => a.nis.localeCompare(b.nis, 'id'));
        cloudCache.students = list;
        notifyStateListeners();
      },
      (error) => {
        handleFirestoreError(error, OperationType.LIST, 'students');
      }
    )
  );

  // 2. Classes listener
  const classesQuery = query(
    collection(db, 'classes'),
    where('schoolCode', '==', SCHOOL_CODE)
  );
  unsubscribers.push(
    onSnapshot(
      classesQuery,
      (snapshot) => {
        const list: ClassRecord[] = snapshot.docs.map((d) => ({
          id: d.id,
          name: String(d.data().name || ''),
        }));
        list.sort((a, b) => a.name.localeCompare(b.name, 'id'));
        cloudCache.classes = list;
        cloudCache.classesLoaded = true;
        notifyStateListeners();
      },
      (error) => {
        handleFirestoreError(error, OperationType.LIST, 'classes');
      }
    )
  );

  // 3. Circulation Logs listener
  const logsQuery = query(
    collection(db, 'circulation_logs'),
    where('schoolCode', '==', SCHOOL_CODE)
  );
  unsubscribers.push(
    onSnapshot(
      logsQuery,
      (snapshot) => {
        const list: CirculationLogRecord[] = snapshot.docs.map((d) => {
          const data = d.data();
          return {
            id: String(data.id || d.id),
            dateKey: String(data.dateKey || ''),
            nis: String(data.nis || ''),
            nama: String(data.nama || ''),
            kelas: String(data.kelas || ''),
            laptopCode: String(data.laptopCode || ''),
            waktuAmbil: String(data.waktuAmbil || ''),
            waktuKembali: String(data.waktuKembali || ''),
            petugasAmbil: String(data.petugasAmbil || ''),
            petugasKembali: String(data.petugasKembali || ''),
            status:
              data.status === 'Dibawa Murid' ? 'Dibawa Murid' : 'Selesai Kembali',
            schoolCode: String(data.schoolCode || SCHOOL_CODE),
            handledByUid: String(data.handledByUid || ''),
          };
        });
        // Urutkan log terbaru di atas
        list.sort((a, b) => {
          const timeA = a.waktuKembali || a.waktuAmbil || '';
          const timeB = b.waktuKembali || b.waktuAmbil || '';
          return timeB.localeCompare(timeA);
        });
        cloudCache.logs = list;
        notifyStateListeners();
      },
      (error) => {
        handleFirestoreError(error, OperationType.LIST, 'circulation_logs');
      }
    )
  );

  // 4. Staff roles & Users listeners (sesuai rule: hanya bootstrapAdmin yang boleh list keseluruhan)
  if (user.isBootstrapAdmin) {
    unsubscribers.push(
      onSnapshot(
        collection(db, 'staff_roles'),
        (snapshot) => {
          const list: StaffRoleRecord[] = snapshot.docs.map((d) => {
            const data = d.data();
            return {
              id: d.id,
              email: String(data.email || ''),
              fullName: String(data.fullName || ''),
              role: data.role === 'admin' ? 'admin' : 'piket',
              assignedByUid: String(data.assignedByUid || ''),
            };
          });
          list.sort((a, b) => a.fullName.localeCompare(b.fullName, 'id'));
          cloudCache.staffRoles = list;
          notifyStateListeners();
        },
        (error) => {
          handleFirestoreError(error, OperationType.LIST, 'staff_roles');
        }
      )
    );

    unsubscribers.push(
      onSnapshot(
        collection(db, 'users'),
        (snapshot) => {
          const list = snapshot.docs.map((d) => {
            const data = d.data();
            return {
              uid: String(data.uid || d.id),
              fullName: String(data.fullName || ''),
              role: (data.role === 'admin' ? 'admin' : 'piket') as 'admin' | 'piket',
            };
          });
          cloudCache.registeredUsers = list;
          notifyStateListeners();
        },
        (error) => {
          handleFirestoreError(error, OperationType.LIST, 'users');
        }
      )
    );
  }
}

onAuthStateChanged(auth, async (firebaseUser) => {
  if (!firebaseUser) {
    clearSubscriptions();
    cloudCache.user = null;
    cloudCache.isReady = true;
    notifyAuthListeners();
    return;
  }

  try {
    const cloudUser = await resolveAndBootstrapUser(firebaseUser);
    cloudCache.user = cloudUser;
    cloudCache.isReady = true;
    attachFirestoreListeners(cloudUser);
    notifyAuthListeners();
  } catch (err) {
    console.error('Gagal menginisialisasi sesi pengguna Firebase:', err);
    cloudCache.user = null;
    cloudCache.isReady = true;
    notifyAuthListeners();
  }
});

// =====================================================================
// API PUBLIK UNTUK UI / INDEX.HTML
// =====================================================================
export const firebaseBackend = {
  onAuthChange(cb: AuthListener): () => void {
    authListeners.add(cb);
    if (cloudCache.isReady) {
      cb(cloudCache.user, true);
    }
    return () => authListeners.delete(cb);
  },

  onDataChange(cb: StateListener): () => void {
    stateListeners.add(cb);
    return () => stateListeners.delete(cb);
  },

  getCurrentUser(): CloudUser | null {
    return cloudCache.user;
  },

  isReady(): boolean {
    return cloudCache.isReady;
  },

  isClassesLoaded(): boolean {
    return cloudCache.classesLoaded;
  },

  getStudents(): StudentRecord[] {
    return cloudCache.students;
  },

  getClasses(): string[] {
    return cloudCache.classes.map((c) => c.name);
  },

  getClassDocs(): ClassRecord[] {
    return cloudCache.classes;
  },

  getLogs(): CirculationLogRecord[] {
    return cloudCache.logs;
  },

  getStaffRoles(): StaffRoleRecord[] {
    return cloudCache.staffRoles;
  },

  getRegisteredUsers() {
    return cloudCache.registeredUsers;
  },

  async signInWithGoogle(): Promise<CloudUser> {
    const provider = new GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });
    const cred = await signInWithPopup(auth, provider);
    const cloudUser = await resolveAndBootstrapUser(cred.user);
    cloudCache.user = cloudUser;
    cloudCache.isReady = true;
    attachFirestoreListeners(cloudUser);
    notifyAuthListeners();
    return cloudUser;
  },

  async signOutUser(): Promise<void> {
    clearSubscriptions();
    await signOut(auth);
  },

  async addClass(name: string): Promise<void> {
    const uid = auth.currentUser?.uid;
    if (!uid) throw new Error('Sesi autentikasi Google belum aktif.');
    const cleanName = clampStr(name, 60);
    if (!cleanName) throw new Error('Nama kelas tidak boleh kosong.');
    const classId = makeSafeClassId(cleanName);
    assertValidId(classId, 'ID Kelas');

    if (
      cloudCache.classes.some(
        (c) => c.id === classId || c.name.toLowerCase() === cleanName.toLowerCase()
      )
    ) {
      return;
    }

    try {
      await setDoc(doc(db, 'classes', classId), {
        name: cleanName,
        schoolCode: SCHOOL_CODE,
        createdByUid: uid,
        createdAt: serverTimestamp(),
      });
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, `classes/${classId}`);
    }
  },

  async deleteClassByName(name: string): Promise<void> {
    const uid = auth.currentUser?.uid;
    if (!uid) throw new Error('Sesi autentikasi Google belum aktif.');
    const found = cloudCache.classes.find(
      (c) => c.name.toLowerCase() === name.trim().toLowerCase()
    );
    if (!found) return;
    try {
      await deleteDoc(doc(db, 'classes', found.id));
    } catch (error) {
      handleFirestoreError(error, OperationType.DELETE, `classes/${found.id}`);
    }
  },

  async upsertStudent(
    payload: {
      nis: string;
      nama: string;
      kelas: string;
      foto: string;
      laptopCode: string;
      laptopBrand: string;
      lastActivityAt: string;
      lastHandledBy: string;
    },
    originalNis = ''
  ): Promise<void> {
    const uid = auth.currentUser?.uid;
    if (!uid) throw new Error('Sesi autentikasi Google belum aktif.');

    const nis = clampStr(payload.nis, 40);
    const laptopCode = clampStr(payload.laptopCode, 40);
    assertValidId(nis, 'NIS / ID Murid', 40);
    assertValidId(laptopCode, 'Kode Laptop', 40);

    const nama = clampStr(payload.nama, 120);
    const kelas = clampStr(payload.kelas, 60);
    const laptopBrand = clampStr(payload.laptopBrand, 100);
    const foto = String(payload.foto || '').slice(0, 100000);
    if (!nama || !kelas || !laptopBrand) {
      throw new Error('Nama murid, kelas, dan seri laptop wajib diisi.');
    }

    if (originalNis && originalNis === nis) {
      // Update dokumen murid yang sama (pertahankan createdAt)
      try {
        await updateDoc(doc(db, 'students', nis), {
          nama,
          kelas,
          foto,
          laptopCode,
          laptopBrand,
          updatedByUid: uid,
          updatedAt: serverTimestamp(),
        });
      } catch (error) {
        handleFirestoreError(error, OperationType.UPDATE, `students/${nis}`);
      }
      return;
    }

    if (originalNis && originalNis !== nis) {
      // NIS berubah -> pindahkan dokumen atomik (buat baru & hapus lama)
      const oldStudent = cloudCache.students.find((s) => s.nis === originalNis);
      const batch = writeBatch(db);
      batch.set(doc(db, 'students', nis), {
        nis,
        nama,
        kelas,
        foto,
        laptopCode,
        laptopBrand,
        laptopStatus: oldStudent?.laptopStatus || 'tersedia',
        blocked: Boolean(oldStudent?.blocked),
        blockReason: clampStr(oldStudent?.blockReason || '', 500),
        lastActivityAt: clampStr(payload.lastActivityAt, 40),
        lastHandledBy: clampStr(payload.lastHandledBy, 120),
        schoolCode: SCHOOL_CODE,
        updatedByUid: uid,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      batch.delete(doc(db, 'students', originalNis));
      try {
        await batch.commit();
      } catch (error) {
        handleFirestoreError(error, OperationType.WRITE, `students/${nis}`);
      }
      return;
    }

    // Buat murid baru
    try {
      await setDoc(doc(db, 'students', nis), {
        nis,
        nama,
        kelas,
        foto,
        laptopCode,
        laptopBrand,
        laptopStatus: 'tersedia',
        blocked: false,
        blockReason: '',
        lastActivityAt: clampStr(payload.lastActivityAt, 40),
        lastHandledBy: clampStr(payload.lastHandledBy, 120),
        schoolCode: SCHOOL_CODE,
        updatedByUid: uid,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, `students/${nis}`);
    }
  },

  async deleteStudent(nis: string): Promise<void> {
    if (!auth.currentUser?.uid) throw new Error('Sesi autentikasi Google belum aktif.');
    try {
      await deleteDoc(doc(db, 'students', nis));
    } catch (error) {
      handleFirestoreError(error, OperationType.DELETE, `students/${nis}`);
    }
  },

  async blockStudent(
    nis: string,
    reason: string,
    timestamp: string,
    handlerName: string
  ): Promise<void> {
    const uid = auth.currentUser?.uid;
    if (!uid) throw new Error('Sesi autentikasi Google belum aktif.');
    try {
      await updateDoc(doc(db, 'students', nis), {
        blocked: true,
        blockReason: clampStr(reason, 500),
        lastActivityAt: clampStr(timestamp, 40),
        lastHandledBy: clampStr(handlerName, 120),
        updatedByUid: uid,
        updatedAt: serverTimestamp(),
      });
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, `students/${nis}`);
    }
  },

  async unblockStudent(
    nis: string,
    timestamp: string,
    handlerName: string
  ): Promise<void> {
    const uid = auth.currentUser?.uid;
    if (!uid) throw new Error('Sesi autentikasi Google belum aktif.');
    try {
      await updateDoc(doc(db, 'students', nis), {
        blocked: false,
        blockReason: '',
        lastActivityAt: clampStr(timestamp, 40),
        lastHandledBy: clampStr(handlerName, 120),
        updatedByUid: uid,
        updatedAt: serverTimestamp(),
      });
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, `students/${nis}`);
    }
  },

  async recordCirculationCheckout(
    student: StudentRecord,
    timestamp: string,
    todayKey: string,
    handlerName: string
  ): Promise<void> {
    const uid = auth.currentUser?.uid;
    if (!uid) throw new Error('Sesi autentikasi Google belum aktif.');

    const logId = `log-${Date.now()}`;
    const batch = writeBatch(db);

    // Update hanya 5 field yang diizinkan untuk Piket maupun Admin
    batch.update(doc(db, 'students', student.nis), {
      laptopStatus: 'dibawa',
      lastActivityAt: clampStr(timestamp, 40),
      lastHandledBy: clampStr(handlerName, 120),
      updatedByUid: uid,
      updatedAt: serverTimestamp(),
    });

    batch.set(doc(db, 'circulation_logs', logId), {
      id: logId,
      dateKey: clampStr(todayKey, 20),
      nis: clampStr(student.nis, 40),
      nama: clampStr(student.nama, 120),
      kelas: clampStr(student.kelas, 60),
      laptopCode: clampStr(student.laptopCode, 40),
      waktuAmbil: clampStr(timestamp, 40),
      waktuKembali: '',
      petugasAmbil: clampStr(handlerName, 120),
      petugasKembali: '',
      status: 'Dibawa Murid',
      schoolCode: SCHOOL_CODE,
      handledByUid: uid,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });

    try {
      await batch.commit();
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, `students/${student.nis}`);
    }
  },

  async recordCirculationReturn(
    student: StudentRecord,
    openLogId: string | null,
    timestamp: string,
    todayKey: string,
    handlerName: string
  ): Promise<void> {
    const uid = auth.currentUser?.uid;
    if (!uid) throw new Error('Sesi autentikasi Google belum aktif.');

    const batch = writeBatch(db);

    batch.update(doc(db, 'students', student.nis), {
      laptopStatus: 'tersedia',
      lastActivityAt: clampStr(timestamp, 40),
      lastHandledBy: clampStr(handlerName, 120),
      updatedByUid: uid,
      updatedAt: serverTimestamp(),
    });

    if (openLogId) {
      batch.update(doc(db, 'circulation_logs', openLogId), {
        waktuKembali: clampStr(timestamp, 40),
        petugasKembali: clampStr(handlerName, 120),
        status: 'Selesai Kembali',
        handledByUid: uid,
        updatedAt: serverTimestamp(),
      });
    } else {
      const logId = `log-${Date.now()}`;
      batch.set(doc(db, 'circulation_logs', logId), {
        id: logId,
        dateKey: clampStr(todayKey, 20),
        nis: clampStr(student.nis, 40),
        nama: clampStr(student.nama, 120),
        kelas: clampStr(student.kelas, 60),
        laptopCode: clampStr(student.laptopCode, 40),
        waktuAmbil: '-',
        waktuKembali: clampStr(timestamp, 40),
        petugasAmbil: '-',
        petugasKembali: clampStr(handlerName, 120),
        status: 'Selesai Kembali',
        schoolCode: SCHOOL_CODE,
        handledByUid: uid,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    }

    try {
      await batch.commit();
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, `students/${student.nis}`);
    }
  },

  async deleteCirculationLog(logId: string): Promise<void> {
    if (!auth.currentUser?.uid) throw new Error('Sesi autentikasi Google belum aktif.');
    try {
      await deleteDoc(doc(db, 'circulation_logs', logId));
    } catch (error) {
      handleFirestoreError(error, OperationType.DELETE, `circulation_logs/${logId}`);
    }
  },

  async clearAllLogs(): Promise<void> {
    if (!auth.currentUser?.uid) throw new Error('Sesi autentikasi Google belum aktif.');
    const batch = writeBatch(db);
    cloudCache.logs.forEach((l) => {
      batch.delete(doc(db, 'circulation_logs', l.id));
    });
    try {
      await batch.commit();
    } catch (error) {
      handleFirestoreError(error, OperationType.DELETE, 'circulation_logs');
    }
  },

  async upsertStaffRole(
    email: string,
    fullName: string,
    role: 'admin' | 'piket'
  ): Promise<void> {
    const uid = auth.currentUser?.uid;
    if (!uid) throw new Error('Sesi autentikasi Google belum aktif.');

    const cleanEmail = clampStr(email, 160).toLowerCase();
    const cleanName = clampStr(fullName, 120);
    if (!cleanEmail || !cleanEmail.includes('@') || !cleanName) {
      throw new Error('Nama lengkap dan alamat email Google valid wajib diisi.');
    }

    const existing = cloudCache.staffRoles.find(
      (r) => r.email.toLowerCase() === cleanEmail
    );

    if (existing) {
      try {
        await updateDoc(doc(db, 'staff_roles', existing.id), {
          fullName: cleanName,
          role,
          assignedByUid: uid,
          updatedAt: serverTimestamp(),
        });
      } catch (error) {
        handleFirestoreError(error, OperationType.UPDATE, `staff_roles/${existing.id}`);
      }
      return;
    }

    const roleId = makeSafeRoleId(cleanEmail);
    assertValidId(roleId, 'ID Peran Staf');
    try {
      await setDoc(doc(db, 'staff_roles', roleId), {
        email: cleanEmail,
        fullName: cleanName,
        role,
        assignedByUid: uid,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, `staff_roles/${roleId}`);
    }
  },

  async deleteStaffRole(roleId: string): Promise<void> {
    if (!auth.currentUser?.uid) throw new Error('Sesi autentikasi Google belum aktif.');
    try {
      await deleteDoc(doc(db, 'staff_roles', roleId));
    } catch (error) {
      handleFirestoreError(error, OperationType.DELETE, `staff_roles/${roleId}`);
    }
  },

  async seedDummyData(
    defaultClasses: string[],
    defaultStudents: StudentRecord[],
    defaultLogs: CirculationLogRecord[]
  ): Promise<void> {
    const uid = auth.currentUser?.uid;
    if (!uid) throw new Error('Sesi autentikasi Google belum aktif.');

    // Batch 1: Hapus logs lama + simpan classes & students terlebih dahulu
    // (Rules circulation_logs create mengecek exists(/students/{nis}) dan blocked == false)
    const batch1 = writeBatch(db);
    cloudCache.logs.forEach((l) => {
      batch1.delete(doc(db, 'circulation_logs', l.id));
    });

    const existingClassIds = new Set(cloudCache.classes.map((c) => c.id));
    defaultClasses.forEach((clsName) => {
      const classId = makeSafeClassId(clsName);
      if (!existingClassIds.has(classId)) {
        batch1.set(doc(db, 'classes', classId), {
          name: clampStr(clsName, 60),
          schoolCode: SCHOOL_CODE,
          createdByUid: uid,
          createdAt: serverTimestamp(),
        });
      }
    });

    const existingStudentNis = new Set(cloudCache.students.map((st) => st.nis));
    defaultStudents.forEach((s) => {
      const nis = clampStr(s.nis, 40);
      if (existingStudentNis.has(nis)) {
        batch1.update(doc(db, 'students', nis), {
          nama: clampStr(s.nama, 120),
          kelas: clampStr(s.kelas, 60),
          foto: String(s.foto || '').slice(0, 100000),
          laptopCode: clampStr(s.laptopCode, 40),
          laptopBrand: clampStr(s.laptopBrand, 100),
          laptopStatus: s.laptopStatus === 'dibawa' ? 'dibawa' : 'tersedia',
          blocked: Boolean(s.blocked),
          blockReason: clampStr(s.blockReason || '', 500),
          lastActivityAt: clampStr(s.lastActivityAt || '', 40),
          lastHandledBy: clampStr(s.lastHandledBy || '', 120),
          updatedByUid: uid,
          updatedAt: serverTimestamp(),
        });
      } else {
        batch1.set(doc(db, 'students', nis), {
          nis,
          nama: clampStr(s.nama, 120),
          kelas: clampStr(s.kelas, 60),
          foto: String(s.foto || '').slice(0, 100000),
          laptopCode: clampStr(s.laptopCode, 40),
          laptopBrand: clampStr(s.laptopBrand, 100),
          laptopStatus: s.laptopStatus === 'dibawa' ? 'dibawa' : 'tersedia',
          blocked: Boolean(s.blocked),
          blockReason: clampStr(s.blockReason || '', 500),
          lastActivityAt: clampStr(s.lastActivityAt || '', 40),
          lastHandledBy: clampStr(s.lastHandledBy || '', 120),
          schoolCode: SCHOOL_CODE,
          updatedByUid: uid,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      }
    });

    try {
      await batch1.commit();
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, 'students');
    }

    // Batch 2: Setelah students ter-commit, simpan circulation_logs
    const batch2 = writeBatch(db);
    defaultLogs.forEach((l) => {
      batch2.set(doc(db, 'circulation_logs', l.id), {
        id: clampStr(l.id, 80),
        dateKey: clampStr(l.dateKey, 20),
        nis: clampStr(l.nis, 40),
        nama: clampStr(l.nama, 120),
        kelas: clampStr(l.kelas, 60),
        laptopCode: clampStr(l.laptopCode, 40),
        waktuAmbil: clampStr(l.waktuAmbil || '', 40),
        waktuKembali: clampStr(l.waktuKembali || '', 40),
        petugasAmbil: clampStr(l.petugasAmbil || '', 120),
        petugasKembali: clampStr(l.petugasKembali || '', 120),
        status: l.status === 'Dibawa Murid' ? 'Dibawa Murid' : 'Selesai Kembali',
        schoolCode: SCHOOL_CODE,
        handledByUid: uid,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    });

    try {
      await batch2.commit();
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, 'circulation_logs');
    }
  },
};

declare global {
  interface Window {
    firebaseBackend?: typeof firebaseBackend;
  }
}

window.firebaseBackend = firebaseBackend;

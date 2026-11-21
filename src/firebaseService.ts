import { initializeApp } from 'firebase/app';
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signInWithEmailAndPassword,
  sendEmailVerification,
  sendPasswordResetEmail,
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
const PROVIDER_ADMIN_EMAILS = ['fadhlihadisurya@gmail.com', 'f4dly.ank2@gmail.com'];
const LOCAL_STAFF_SESSION_KEY = 'piketlaptop_local_staff_id';
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
  username?: string;
  email: string;
  fullName: string;
  role: 'admin' | 'piket';
  isBootstrapAdmin: boolean;
  isProviderAdmin?: boolean;
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
  username: string;
  email: string;
  fullName: string;
  role: 'admin' | 'piket';
  password: string;
  assignedByUid: string;
}

export interface ClassRecord {
  id: string;
  name: string;
}

type StateListener = () => void;
type AuthListener = (
  user: CloudUser | null,
  isReady: boolean,
  unverifiedEmail?: string | null
) => void;

const cloudCache = {
  isReady: false,
  studentsLoaded: false,
  classesLoaded: false,
  logsLoaded: false,
  user: null as CloudUser | null,
  unverifiedEmail: null as string | null,
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
      fn(cloudCache.user, cloudCache.isReady, cloudCache.unverifiedEmail);
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
  cloudCache.studentsLoaded = false;
  cloudCache.classesLoaded = false;
  cloudCache.logsLoaded = false;
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

function getActiveActorUid(): string {
  return auth.currentUser?.uid || cloudCache.user?.uid || '';
}

async function resolveAndBootstrapUser(firebaseUser: User): Promise<CloudUser> {
  const uid = firebaseUser.uid;
  const emailLower = (firebaseUser.email || '').trim().toLowerCase();
  const isBootstrap = PROVIDER_ADMIN_EMAILS.includes(emailLower);

  const isPasswordProvider =
    firebaseUser.providerData.some((p) => p.providerId === 'password') ||
    (firebaseUser as any).providerId === 'password';

  // 1. Cek apakah user memiliki dokumen di /admins/{uid}
  let hasAdminMarker = false;
  try {
    const adminSnap = await getDoc(doc(db, 'admins', uid));
    hasAdminMarker = adminSnap.exists();
  } catch (error) {
    handleFirestoreError(error, OperationType.GET, `admins/${uid}`);
  }

  // 2. Cek apakah email staf terdaftar di /staff_roles (query sesuai rule list: role in ['admin', 'piket'])
  let assignedStaffRole: StaffRoleRecord | null = null;
  if (emailLower) {
    try {
      const roleQuery = query(
        collection(db, 'staff_roles'),
        where('role', 'in', ['admin', 'piket'])
      );
      const roleSnap = await getDocs(roleQuery);
      const matchedDoc = roleSnap.docs.find(
        (d) => String(d.data().email || '').trim().toLowerCase() === emailLower
      );
      if (matchedDoc) {
        const data = matchedDoc.data();
        const fallbackUsername = emailLower.includes('@') ? emailLower.split('@')[0] : emailLower;
        assignedStaffRole = {
          id: matchedDoc.id,
          username: String(data.username || fallbackUsername),
          email: String(data.email || emailLower),
          fullName: String(data.fullName || ''),
          role: data.role === 'admin' ? 'admin' : 'piket',
          password: String(data.password || ''),
          assignedByUid: String(data.assignedByUid || ''),
        };
      }
    } catch (error) {
      handleFirestoreError(error, OperationType.LIST, 'staff_roles');
    }
  }

  // 3. Jika Bootstrap Admin atau login Email/Password dan belum memiliki dokumen /admins/{uid}, buat penanda admin
  if ((isBootstrap || isPasswordProvider) && !hasAdminMarker) {
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
      'Superadmin Sekolah',
    120
  );

  let effectiveRole: 'admin' | 'piket' = 'piket';
  if (isBootstrap || isPasswordProvider || hasAdminMarker || existingUserData?.role === 'admin') {
    effectiveRole = 'admin';
  }

  // 5. Pastikan dokumen /users/{uid} ada dan sinkron (tanpa menyimpan PII email)
  if (!existingUserData) {
    const createRole: 'admin' | 'piket' = isBootstrap || isPasswordProvider || hasAdminMarker ? 'admin' : 'piket';
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
  } else if ((isBootstrap || isPasswordProvider) && existingUserData.role !== 'admin') {
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
    username: emailLower.includes('@') ? emailLower.split('@')[0] : emailLower,
    email: emailLower,
    fullName: displayName,
    role: effectiveRole,
    isBootstrapAdmin: isBootstrap,
    isProviderAdmin: true,
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
        cloudCache.studentsLoaded = true;
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
        cloudCache.logsLoaded = true;
        notifyStateListeners();
      },
      (error) => {
        handleFirestoreError(error, OperationType.LIST, 'circulation_logs');
      }
    )
  );

  // 4. Staff roles listener untuk Admin (menggunakan query sesuai rule list)
  if (user.role === 'admin' || user.isBootstrapAdmin) {
    const staffRolesQuery = query(
      collection(db, 'staff_roles'),
      where('role', 'in', ['admin', 'piket'])
    );
    unsubscribers.push(
      onSnapshot(
        staffRolesQuery,
        (snapshot) => {
          const list: StaffRoleRecord[] = snapshot.docs.map((d) => {
            const data = d.data();
            const emailVal = String(data.email || '');
            const fallbackUsername = emailVal.includes('@')
              ? emailVal.split('@')[0]
              : emailVal || d.id.replace(/^role-/, '');
            return {
              id: d.id,
              username: String(data.username || fallbackUsername),
              email: emailVal,
              fullName: String(data.fullName || ''),
              role: data.role === 'admin' ? 'admin' : 'piket',
              password: String(data.password || ''),
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
  }
}

onAuthStateChanged(auth, async (firebaseUser) => {
  if (!firebaseUser) {
    const savedLocalStaffId = sessionStorage.getItem(LOCAL_STAFF_SESSION_KEY);
    if (savedLocalStaffId && VALID_ID_REGEX.test(savedLocalStaffId)) {
      try {
        const snap = await getDoc(doc(db, 'staff_roles', savedLocalStaffId));
        if (snap.exists()) {
          const data = snap.data();
          if (data.role === 'admin' || data.role === 'piket') {
            const emailLower = String(data.email || `${savedLocalStaffId}@piketlaptop.local`).toLowerCase();
            const uname = String(
              data.username || (emailLower.includes('@') ? emailLower.split('@')[0] : savedLocalStaffId.replace(/^role-/, ''))
            );
            const isProvider = PROVIDER_ADMIN_EMAILS.includes(emailLower);
            const cloudUser: CloudUser = {
              id: snap.id,
              uid: snap.id,
              username: uname,
              email: emailLower,
              fullName: String(data.fullName || uname),
              role: data.role === 'admin' ? 'admin' : 'piket',
              isBootstrapAdmin: isProvider,
              isProviderAdmin: isProvider,
            };
            cloudCache.unverifiedEmail = null;
            cloudCache.user = cloudUser;
            cloudCache.isReady = true;
            attachFirestoreListeners(cloudUser);
            notifyAuthListeners();
            return;
          }
        }
      } catch {
        // lanjut bersihkan sesi lokal jika gagal memuat
      }
      sessionStorage.removeItem(LOCAL_STAFF_SESSION_KEY);
    }

    clearSubscriptions();
    cloudCache.user = null;
    cloudCache.unverifiedEmail = null;
    cloudCache.isReady = true;
    notifyAuthListeners();
    return;
  }

  if (!firebaseUser.emailVerified) {
    clearSubscriptions();
    cloudCache.user = null;
    cloudCache.unverifiedEmail = firebaseUser.email || 'Email Anda';
    cloudCache.isReady = true;
    notifyAuthListeners();
    return;
  }

  sessionStorage.removeItem(LOCAL_STAFF_SESSION_KEY);
  cloudCache.unverifiedEmail = null;
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
      cb(cloudCache.user, true, cloudCache.unverifiedEmail);
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

  areCollectionsLoaded(): boolean {
    return (
      cloudCache.studentsLoaded &&
      cloudCache.classesLoaded &&
      cloudCache.logsLoaded
    );
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

  getUnverifiedEmail(): string | null {
    return cloudCache.unverifiedEmail;
  },

  async signInWithGoogle(): Promise<CloudUser> {
    const provider = new GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });
    const cred = await signInWithPopup(auth, provider);
    cloudCache.unverifiedEmail = null;
    const cloudUser = await resolveAndBootstrapUser(cred.user);
    cloudCache.user = cloudUser;
    cloudCache.isReady = true;
    attachFirestoreListeners(cloudUser);
    notifyAuthListeners();
    return cloudUser;
  },

  async signInUnified(
    usernameOrEmail: string,
    password: string
  ): Promise<
    | { status: 'signed_in'; user: CloudUser }
    | { status: 'verification_required'; email: string; verificationSent: boolean }
  > {
    const cleanInput = usernameOrEmail.trim().toLowerCase();
    const cleanPass = password.trim();
    if (!cleanInput || !cleanPass) {
      throw new Error('Username/email dan password wajib diisi.');
    }

    // 1. Jika input berformat email (@)
    if (cleanInput.includes('@')) {
      try {
        const authResult = await this.signInWithEmail(cleanInput, cleanPass);
        return authResult;
      } catch (authErr: any) {
        // Fallback ke staff_roles lokal Firestore jika ada akun staff_roles dengan email ini
        try {
          const localUser = await this.signInWithUsername(cleanInput, cleanPass);
          return { status: 'signed_in', user: localUser };
        } catch {
          throw authErr;
        }
      }
    }

    // 2. Jika input adalah username biasa (tanpa @)
    try {
      const localUser = await this.signInWithUsername(cleanInput, cleanPass);
      return { status: 'signed_in', user: localUser };
    } catch (localErr) {
      // Cek apakah username ini memiliki email terdaftar di staff_roles yang memakai Firebase Auth
      let matchedEmail = '';
      try {
        const rolesQuery = query(
          collection(db, 'staff_roles'),
          where('role', 'in', ['admin', 'piket'])
        );
        const allRolesSnap = await getDocs(rolesQuery);
        for (const d of allRolesSnap.docs) {
          const data = d.data();
          const emailVal = String(data.email || '').trim().toLowerCase();
          const unameVal = String(data.username || '').trim().toLowerCase();
          const baseName = emailVal.includes('@') ? emailVal.split('@')[0] : emailVal;
          if ((unameVal === cleanInput || baseName === cleanInput) && emailVal.includes('@')) {
            matchedEmail = emailVal;
            break;
          }
        }
      } catch {
        // abaikan
      }

      if (matchedEmail) {
        try {
          const authResult = await this.signInWithEmail(matchedEmail, cleanPass);
          return authResult;
        } catch {
          // abaikan
        }
      }

      throw localErr;
    }
  },

  async signInWithUsername(
    username: string,
    password: string
  ): Promise<CloudUser> {
    const cleanUser = username.trim().toLowerCase();
    const cleanPass = password.trim();
    if (!cleanUser || !cleanPass) {
      throw new Error('Username dan password wajib diisi.');
    }

    let allRolesSnap;
    try {
      const rolesQuery = query(
        collection(db, 'staff_roles'),
        where('role', 'in', ['admin', 'piket'])
      );
      allRolesSnap = await getDocs(rolesQuery);
    } catch (error) {
      handleFirestoreError(error, OperationType.LIST, 'staff_roles');
    }

    let matchedDoc: Record<string, any> | null = null;
    let matchedId = '';

    for (const d of allRolesSnap.docs) {
      const data = d.data();
      const emailVal = String(data.email || '').trim().toLowerCase();
      const unameVal = String(data.username || '').trim().toLowerCase();
      const baseName = emailVal.includes('@') ? emailVal.split('@')[0] : emailVal;
      if (emailVal === cleanUser || unameVal === cleanUser || baseName === cleanUser) {
        matchedDoc = data;
        matchedId = d.id;
        break;
      }
    }

    if (!matchedDoc || !matchedId) {
      throw new Error('Username tidak ditemukan di Firestore.');
    }

    if (!matchedDoc.password || String(matchedDoc.password) !== cleanPass) {
      throw new Error('Password salah.');
    }

    const emailLower = String(matchedDoc.email || `${cleanUser}@piketlaptop.local`).toLowerCase();
    const uname = String(
      matchedDoc.username || (emailLower.includes('@') ? emailLower.split('@')[0] : cleanUser)
    );
    const fullName = String(matchedDoc.fullName || uname);
    const role = matchedDoc.role === 'admin' ? 'admin' : 'piket';
    const isProvider = PROVIDER_ADMIN_EMAILS.includes(emailLower);

    const cloudUser: CloudUser = {
      id: matchedId,
      uid: matchedId,
      username: uname,
      email: emailLower,
      fullName,
      role,
      isBootstrapAdmin: isProvider,
      isProviderAdmin: isProvider,
    };

    sessionStorage.setItem(LOCAL_STAFF_SESSION_KEY, matchedId);
    cloudCache.unverifiedEmail = null;
    cloudCache.user = cloudUser;
    cloudCache.isReady = true;
    attachFirestoreListeners(cloudUser);
    notifyAuthListeners();
    return cloudUser;
  },

  async signInWithEmail(
    email: string,
    password: string
  ): Promise<
    | { status: 'signed_in'; user: CloudUser }
    | { status: 'verification_required'; email: string; verificationSent: boolean }
  > {
    const cleanEmail = email.trim();
    if (!cleanEmail || !password) {
      throw new Error('Email dan password superadmin wajib diisi.');
    }
    const cred = await signInWithEmailAndPassword(auth, cleanEmail, password);
    if (!cred.user.emailVerified) {
      let verificationSent = false;
      try {
        await sendEmailVerification(cred.user);
        verificationSent = true;
      } catch {
        verificationSent = false;
      }
      clearSubscriptions();
      cloudCache.user = null;
      cloudCache.unverifiedEmail = cred.user.email || cleanEmail;
      cloudCache.isReady = true;
      notifyAuthListeners();
      return {
        status: 'verification_required',
        email: cred.user.email || cleanEmail,
        verificationSent,
      };
    }

    cloudCache.unverifiedEmail = null;
    const cloudUser = await resolveAndBootstrapUser(cred.user);
    cloudCache.user = cloudUser;
    cloudCache.isReady = true;
    attachFirestoreListeners(cloudUser);
    notifyAuthListeners();
    return { status: 'signed_in', user: cloudUser };
  },

  async resendVerificationEmail(): Promise<void> {
    if (!auth.currentUser) {
      throw new Error('Tidak ada sesi email yang menunggu verifikasi.');
    }
    await sendEmailVerification(auth.currentUser);
  },

  async reloadAndVerifyEmail(): Promise<CloudUser | null> {
    if (!auth.currentUser) {
      throw new Error('Tidak ada sesi email yang aktif.');
    }
    await auth.currentUser.reload();
    if (!auth.currentUser.emailVerified) {
      return null;
    }
    await auth.currentUser.getIdToken(true);
    cloudCache.unverifiedEmail = null;
    const cloudUser = await resolveAndBootstrapUser(auth.currentUser);
    cloudCache.user = cloudUser;
    cloudCache.isReady = true;
    attachFirestoreListeners(cloudUser);
    notifyAuthListeners();
    return cloudUser;
  },

  async sendPasswordReset(email: string): Promise<void> {
    const cleanEmail = email.trim();
    if (!cleanEmail || !cleanEmail.includes('@')) {
      throw new Error('Masukkan alamat email superadmin yang valid terlebih dahulu.');
    }
    await sendPasswordResetEmail(auth, cleanEmail);
  },

  async signOutUser(): Promise<void> {
    sessionStorage.removeItem(LOCAL_STAFF_SESSION_KEY);
    clearSubscriptions();
    cloudCache.user = null;
    cloudCache.unverifiedEmail = null;
    await signOut(auth);
    notifyAuthListeners();
  },

  async addClass(name: string): Promise<void> {
    const uid = getActiveActorUid();
    if (!uid) throw new Error('Sesi autentikasi belum aktif.');
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
    const uid = getActiveActorUid();
    if (!uid) throw new Error('Sesi autentikasi belum aktif.');
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
    const uid = getActiveActorUid();
    if (!uid) throw new Error('Sesi autentikasi belum aktif.');

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
    if (!getActiveActorUid()) throw new Error('Sesi autentikasi belum aktif.');
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
    const uid = getActiveActorUid();
    if (!uid) throw new Error('Sesi autentikasi belum aktif.');
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
    const uid = getActiveActorUid();
    if (!uid) throw new Error('Sesi autentikasi belum aktif.');
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
    const uid = getActiveActorUid();
    if (!uid) throw new Error('Sesi autentikasi belum aktif.');

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
    const uid = getActiveActorUid();
    if (!uid) throw new Error('Sesi autentikasi belum aktif.');

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
    if (!getActiveActorUid()) throw new Error('Sesi autentikasi belum aktif.');
    try {
      await deleteDoc(doc(db, 'circulation_logs', logId));
    } catch (error) {
      handleFirestoreError(error, OperationType.DELETE, `circulation_logs/${logId}`);
    }
  },

  async clearAllLogs(): Promise<void> {
    if (!getActiveActorUid()) throw new Error('Sesi autentikasi belum aktif.');
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
    identifier: string,
    fullName: string,
    role: 'admin' | 'piket',
    password = ''
  ): Promise<void> {
    const uid = getActiveActorUid();
    if (!uid) throw new Error('Sesi autentikasi belum aktif.');

    const cleanInput = clampStr(identifier, 160).toLowerCase();
    const cleanName = clampStr(fullName, 120);
    const cleanPassword = clampStr(password, 100);
    if (!cleanInput || !cleanName) {
      throw new Error('Nama lengkap dan username wajib diisi.');
    }

    const cleanUsername = clampStr(
      cleanInput.includes('@') ? cleanInput.split('@')[0] : cleanInput,
      80
    );
    if (!cleanUsername) {
      throw new Error('Username tidak valid.');
    }
    const email = cleanInput.includes('@')
      ? cleanInput
      : `${cleanUsername}@piketlaptop.local`;

    const existing = cloudCache.staffRoles.find(
      (r) =>
        r.id === makeSafeRoleId(cleanUsername) ||
        r.id === makeSafeRoleId(cleanInput) ||
        r.username.toLowerCase() === cleanUsername ||
        r.email.toLowerCase() === email
    );

    if (existing) {
      if (PROVIDER_ADMIN_EMAILS.includes(existing.email.toLowerCase()) && role !== 'admin') {
        throw new Error('Admin yang login dari provider tidak dapat diubah menjadi piket.');
      }
      try {
        await updateDoc(doc(db, 'staff_roles', existing.id), {
          username: cleanUsername,
          email,
          fullName: cleanName,
          role,
          password: cleanPassword || existing.password || '',
          assignedByUid: uid,
          updatedAt: serverTimestamp(),
        });
      } catch (error) {
        handleFirestoreError(error, OperationType.UPDATE, `staff_roles/${existing.id}`);
      }
      return;
    }

    if (!cleanPassword || cleanPassword.length < 4) {
      throw new Error('Password wajib diisi minimal 4 karakter.');
    }

    const roleId = makeSafeRoleId(cleanUsername);
    assertValidId(roleId, 'ID Peran Staf');
    try {
      await setDoc(doc(db, 'staff_roles', roleId), {
        username: cleanUsername,
        email,
        fullName: cleanName,
        role,
        password: cleanPassword,
        assignedByUid: uid,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, `staff_roles/${roleId}`);
    }
  },

  async deleteStaffRole(roleId: string): Promise<void> {
    if (!getActiveActorUid()) throw new Error('Sesi autentikasi belum aktif.');
    const target = cloudCache.staffRoles.find((r) => r.id === roleId);
    if (target && PROVIDER_ADMIN_EMAILS.includes(target.email.toLowerCase())) {
      throw new Error('Admin yang login dari provider tidak dapat dihapus.');
    }
    if (cloudCache.user && cloudCache.user.uid === roleId) {
      throw new Error('Tidak dapat menghapus akun yang sedang digunakan.');
    }
    try {
      await deleteDoc(doc(db, 'staff_roles', roleId));
    } catch (error) {
      handleFirestoreError(error, OperationType.DELETE, `staff_roles/${roleId}`);
    }
  },

  async setRegisteredUserRole(targetUid: string, newRole: 'admin' | 'piket'): Promise<void> {
    const uid = getActiveActorUid();
    if (!uid) throw new Error('Sesi autentikasi belum aktif.');
    const cleanUid = clampStr(targetUid, 128);
    assertValidId(cleanUid, 'UID Pengguna');

    try {
      await updateDoc(doc(db, 'users', cleanUid), {
        role: newRole,
        updatedAt: serverTimestamp(),
      });
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, `users/${cleanUid}`);
    }
  },

  async seedDummyData(
    defaultClasses: string[],
    defaultStudents: StudentRecord[],
    defaultLogs: CirculationLogRecord[]
  ): Promise<void> {
    const uid = getActiveActorUid();
    if (!uid) throw new Error('Sesi autentikasi belum aktif.');

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

    // Batch 2: Setelah students ter-commit, simpan circulation_logs yang valid (murid ada & tidak diblokir)
    const allowedLogNis = new Set(
      defaultStudents.filter((s) => !s.blocked).map((s) => clampStr(s.nis, 40))
    );
    const validLogs = defaultLogs.filter((l) => {
      const nis = clampStr(l.nis, 40);
      const id = clampStr(l.id, 80);
      return (
        allowedLogNis.has(nis) &&
        VALID_ID_REGEX.test(id) &&
        VALID_ID_REGEX.test(clampStr(l.laptopCode, 40))
      );
    });

    if (validLogs.length > 0) {
      const batch2 = writeBatch(db);
      validLogs.forEach((l) => {
        batch2.set(doc(db, 'circulation_logs', clampStr(l.id, 80)), {
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
    }
  },
};

declare global {
  interface Window {
    firebaseBackend?: typeof firebaseBackend;
  }
}

window.firebaseBackend = firebaseBackend;
window.dispatchEvent(new CustomEvent('firebaseBackendReady'));

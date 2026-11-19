# Security Specification: Sistem Sirkulasi Laptop Murid (Firestore)

## 1. Data Invariants
1. **Default-Deny Baseline**: Seluruh operasi baca/tulis pada jalur tak dikenal ditolak (`allow read, write: if false`).
2. **Verified Auth Required**: Semua akses data mewajibkan `request.auth != null && request.auth.token.email_verified == true`.
3. **Anti Privilege Escalation**: Pengguna non-admin hanya dapat mendaftarkan profil `/users/{uid}` dengan `role == 'piket'` dan tidak dapat mengubah `role` miliknya sendiri atau menulis ke `/admins/{uid}` atau `/staff_roles/{roleId}`.
4. **Tiered Circulation Update**: Petugas Piket hanya diizinkan memperbarui field sirkulasi (`laptopStatus`, `lastActivityAt`, `lastHandledBy`, `updatedByUid`, `updatedAt`) pada murid yang **tidak** berstatus `blocked == true`, serta tidak dapat mengubah `blocked`, `blockReason`, `nis`, `nama`, `kelas`, `laptopCode`, atau `foto`.
5. **Terminal State Locking**: Log sirkulasi dengan `status == 'Selesai Kembali'` tidak dapat diubah lagi oleh Petugas Piket (hanya Admin yang memiliki hak koreksi/hapus).
6. **PII Isolation**: Alamat email staf pada `/staff_roles/{roleId}` hanya dapat dibaca oleh Admin atau pemilik email itu sendiri (`resource.data.email == request.auth.token.email`).
7. **Temporal Integrity**: Field `createdAt` dan `updatedAt` wajib bernilai `request.time`.

## 2. The "Dirty Dozen" Attack Payloads (Must All Return PERMISSION_DENIED)
1. **Unauthenticated Student Read**: `get /students/20261001` dengan `auth = null`.
2. **Unverified Email Spoof**: `get /students/20261001` dengan `email = "Fadhlihadisurya@gmail.com"` tetapi `email_verified = false`.
3. **Self-Assigned Admin Role**: `create /users/attackerUid` oleh non-admin dengan `{ uid: "attackerUid", fullName: "Hacker", role: "admin", createdAt: request.time, updatedAt: request.time }`.
4. **Role Escalation Update**: `update /users/piketUid` oleh Piket untuk mengubah `role` dari `"piket"` menjadi `"admin"`.
5. **Shadow Ghost Field Injection**: `create /students/20261999` oleh Admin dengan field tambahan ilegal `isSuperBypass: true`.
6. **Piket Unblocking Suspended Student**: `update /students/20261003` oleh Piket mengubah `blocked: false` atau `blockReason: ""`.
7. **Piket Checking Out Blocked Student**: `update /students/20261003` (di mana `existing().blocked == true`) oleh Piket mengubah `laptopStatus: "dibawa"`.
8. **Piket Modifying Student Identity/Laptop**: `update /students/20261001` oleh Piket mengubah `laptopCode` atau `nama`.
9. **Piket Deleting Student or Circulation Log**: `delete /students/20261001` atau `delete /circulation_logs/log1` oleh Piket.
10. **PII Scraping on Staff Roles**: `list /staff_roles` atau `get /staff_roles/other` oleh non-admin.
11. **ID Poisoning (>128 chars / invalid chars)**: `create /students/<1500-char-id>` atau `create /circulation_logs/bad$id`.
12. **Client Timestamp Forgery & Terminal Log Reopen**: `create /circulation_logs/log2` dengan `createdAt` palsu (bukan `request.time`) atau `update` oleh Piket mengubah `status` dari `"Selesai Kembali"` kembali ke `"Dibawa Murid"`.

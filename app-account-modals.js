// Account dropdown modals -- Manage Users (admin-only), My Profile,
// Security (self-service Change Password), and Data Management. Split
// out of app.js -- see app.js's own top-of-file comment for the overall
// file split.
import {
  escapeHtml, formatActivityDateTime, showCloudError, wireModalOverlayClose,
  resizeImageFile, currentUser, myProfile, userProfilesCol,
  auth, ADMIN_EMAIL, MODULE_PERMISSIONS, userModulePermissions, authErrorMessage, userApprovalsCol
} from './app.js';
import {
  doc, setDoc, onSnapshot
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  EmailAuthProvider, reauthenticateWithCredential, sendPasswordResetEmail, updatePassword
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

/* ---------- Manage Users (admin-only) ----------
   Visible only to ADMIN_EMAIL (see renderApp's btnOpenUserAdmin toggle).
   Lists every userApprovals doc — pending requests up top with Approve/
   Reject, then everyone underneath with their current status and a "Send
   Reset Email" action (the closest thing to an admin-driven password reset
   this client-only app can do — see ADMIN_EMAIL's own comment). */
const USER_ADMIN_STATUS_LABEL = { pending: 'Pending', approved: 'Approved', rejected: 'Rejected' };
// Only the admin ever attaches this — see initUserAdminPanel — a live
// listener over every userApprovals doc so the panel can list pending
// requests and every account's status. Also torn down from core app.js's
// own logout branch -- an importing module can't reassign another
// module's `let` directly, so that branch calls setUnsubscribeUserApprovalsAdmin
// instead of reassigning this directly, same fix as setMuEditSnapshotBefore/
// setHomeCalendarPanes earlier this session.
export let unsubscribeUserApprovalsAdmin = null;
export function setUnsubscribeUserApprovalsAdmin(v){ unsubscribeUserApprovalsAdmin = v; }
let userApprovalsAdminList = [];
function userAdminRowHtml(item, isPendingSection){
  const statusLabel = USER_ADMIN_STATUS_LABEL[item.status] || item.status;
  return `
    <div class="user-admin-row">
      <div class="user-admin-row-main">
        <div class="user-admin-row-email">${escapeHtml(item.email || '(no email)')}</div>
        <div class="user-admin-row-meta">
          ${isPendingSection
            ? `Requested ${escapeHtml(formatActivityDateTime(item.requestedAt) || '')}`
            : `<span class="user-admin-status user-admin-status-${escapeHtml(item.status || 'pending')}">${escapeHtml(statusLabel)}</span>${item.decidedBy ? ` &nbsp;·&nbsp; by ${escapeHtml(item.decidedBy)}` : ''}`}
        </div>
      </div>
      <div class="user-admin-row-actions">
        ${item.status !== 'approved' ? `<button class="btn btn-sm btn-primary" data-role="approve" data-uid="${escapeHtml(item.id)}">Approve</button>` : ''}
        ${item.status !== 'rejected' ? `<button class="btn btn-sm btn-danger" data-role="reject" data-uid="${escapeHtml(item.id)}">Reject</button>` : ''}
        <button class="btn btn-sm" data-role="reset-email" data-email="${escapeHtml(item.email || '')}">Send Reset Email</button>
      </div>
      ${!isPendingSection && item.email !== ADMIN_EMAIL ? `
      <div class="user-admin-permissions">
        ${MODULE_PERMISSIONS.map(m => `
          <label class="user-admin-permission-toggle">
            <input type="checkbox" data-role="toggle-permission" data-uid="${escapeHtml(item.id)}" data-module="${m.key}" ${userModulePermissions(item)[m.key] ? 'checked' : ''}>
            ${escapeHtml(m.label)}
          </label>
        `).join('')}
      </div>
      ` : ''}
    </div>
  `;
}
function renderUserAdminLists(){
  const pendingList = document.getElementById('userAdminPendingList');
  const allList = document.getElementById('userAdminAllList');
  if(!pendingList || !allList) return;
  const sorted = [...userApprovalsAdminList].sort((a, b) => (a.email || '').localeCompare(b.email || ''));
  const pending = sorted.filter(u => u.status === 'pending');
  pendingList.innerHTML = pending.length
    ? pending.map(u => userAdminRowHtml(u, true)).join('')
    : '<div class="overview-empty">Nothing pending</div>';
  allList.innerHTML = sorted.length
    ? sorted.map(u => userAdminRowHtml(u, false)).join('')
    : '<div class="overview-empty">No sign-ups yet</div>';
  document.querySelectorAll('#userAdminModalOverlay [data-role="approve"]').forEach(btn => {
    btn.addEventListener('click', () => decideUserApproval(btn.dataset.uid, 'approved'));
  });
  document.querySelectorAll('#userAdminModalOverlay [data-role="reject"]').forEach(btn => {
    btn.addEventListener('click', () => decideUserApproval(btn.dataset.uid, 'rejected'));
  });
  document.querySelectorAll('#userAdminModalOverlay [data-role="toggle-permission"]').forEach(cb => {
    cb.addEventListener('change', () => {
      const checked = cb.checked;
      setDoc(doc(userApprovalsCol, cb.dataset.uid), { permissions: { [cb.dataset.module]: checked } }, { merge: true })
        .catch(err => { alert('Failed to update: ' + err.message); cb.checked = !checked; });
    });
  });
  document.querySelectorAll('#userAdminModalOverlay [data-role="reset-email"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const email = btn.dataset.email;
      if(!email) return;
      const originalLabel = btn.textContent;
      btn.disabled = true;
      sendPasswordResetEmail(auth, email)
        .then(() => { btn.textContent = 'Sent!'; setTimeout(() => { btn.textContent = originalLabel; btn.disabled = false; }, 2500); })
        .catch(err => { alert(authErrorMessage(err)); btn.textContent = originalLabel; btn.disabled = false; });
    });
  });
}
function decideUserApproval(uidToDecide, status){
  if(!uidToDecide) return;
  setDoc(doc(userApprovalsCol, uidToDecide), {
    status,
    decidedBy: currentUser?.email || '',
    decidedAt: Date.now()
  }, { merge: true }).catch(err => alert('Failed to update: ' + err.message));
}
export function initUserAdminPanel(){
  document.getElementById('btnOpenUserAdmin').addEventListener('click', () => {
    document.getElementById('navbarAccount').classList.remove('open');
    document.getElementById('userAdminModalOverlay').classList.add('open');
    if(!unsubscribeUserApprovalsAdmin){
      unsubscribeUserApprovalsAdmin = onSnapshot(userApprovalsCol, snapshot => {
        userApprovalsAdminList = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
        renderUserAdminLists();
      }, err => {
        console.error('Forge: user admin listener error', err);
        showCloudError('Failed to load user list: ' + err.message);
      });
    }
  });
  document.getElementById('btnCloseUserAdmin').addEventListener('click', () => {
    document.getElementById('userAdminModalOverlay').classList.remove('open');
  });
  document.getElementById('userAdminModalOverlay').addEventListener('click', e => {
    if(e.target.id === 'userAdminModalOverlay') document.getElementById('userAdminModalOverlay').classList.remove('open');
  });
}

/* ---------- My Profile ---------- */
let editingProfileImage = ''; // staged photo for the My Profile modal, same pattern as newProjectImage
export function initMyProfileModal(){
  const nameInput = document.getElementById('myProfileNameInput');
  const imageInput = document.getElementById('myProfileImageInput');
  const imagePreview = document.getElementById('myProfileImagePreview');
  const imageRemoveBtn = document.getElementById('myProfileImageRemove');
  const errEl = document.getElementById('myProfileError');
  const successEl = document.getElementById('myProfileSuccess');

  function openMyProfileModal(){
    document.getElementById('navbarAccount').classList.remove('open');
    nameInput.value = myProfile.displayName || '';
    editingProfileImage = myProfile.photoImage || '';
    if(editingProfileImage){
      imagePreview.src = editingProfileImage;
      imagePreview.style.display = '';
      imageRemoveBtn.style.display = '';
    }else{
      imagePreview.src = '';
      imagePreview.style.display = 'none';
      imageRemoveBtn.style.display = 'none';
    }
    imageInput.value = '';
    errEl.textContent = '';
    successEl.textContent = '';
    document.getElementById('myProfileModalOverlay').classList.add('open');
  }
  function closeMyProfileModal(){
    document.getElementById('myProfileModalOverlay').classList.remove('open');
  }

  document.getElementById('btnOpenMyProfile').addEventListener('click', openMyProfileModal);
  document.getElementById('btnCloseMyProfile').addEventListener('click', closeMyProfileModal);
  document.getElementById('btnCancelMyProfile').addEventListener('click', closeMyProfileModal);
  wireModalOverlayClose('myProfileModalOverlay', closeMyProfileModal);

  imageInput.addEventListener('change', async e => {
    const file = e.target.files[0];
    if(!file) return;
    try{
      editingProfileImage = await resizeImageFile(file, 300);
      imagePreview.src = editingProfileImage;
      imagePreview.style.display = '';
      imageRemoveBtn.style.display = '';
    }catch(err){
      errEl.textContent = err.message || 'Could not read that image file';
    }
  });
  imageRemoveBtn.addEventListener('click', () => {
    editingProfileImage = '';
    imageInput.value = '';
    imagePreview.src = '';
    imagePreview.style.display = 'none';
    imageRemoveBtn.style.display = 'none';
  });

  document.getElementById('btnSaveMyProfile').addEventListener('click', () => {
    errEl.textContent = '';
    setDoc(doc(userProfilesCol, currentUser.uid), {
      displayName: nameInput.value.trim(),
      photoImage: editingProfileImage,
      updatedAt: Date.now()
    }, { merge: true })
      .then(() => {
        successEl.textContent = 'Saved!';
        setTimeout(closeMyProfileModal, 800);
      })
      .catch(err => { errEl.textContent = 'Failed to save: ' + err.message; });
  });
}

/* ---------- Security (self-service Change Password) ---------- */
export function initSecurityModal(){
  const form = document.getElementById('changePasswordForm');
  const errEl = document.getElementById('securityError');
  const successEl = document.getElementById('securitySuccess');

  function openSecurityModal(){
    document.getElementById('navbarAccount').classList.remove('open');
    form.reset();
    errEl.textContent = '';
    successEl.textContent = '';
    document.getElementById('securityModalOverlay').classList.add('open');
  }
  function closeSecurityModal(){
    document.getElementById('securityModalOverlay').classList.remove('open');
  }

  document.getElementById('btnOpenSecurity').addEventListener('click', openSecurityModal);
  document.getElementById('btnCloseSecurity').addEventListener('click', closeSecurityModal);
  wireModalOverlayClose('securityModalOverlay', closeSecurityModal);

  form.addEventListener('submit', e => {
    e.preventDefault();
    errEl.textContent = '';
    successEl.textContent = '';
    const currentPassword = document.getElementById('securityCurrentPassword').value;
    const newPassword = document.getElementById('securityNewPassword').value;
    const newPassword2 = document.getElementById('securityNewPassword2').value;
    if(newPassword.length < 6){
      errEl.textContent = 'New password must be at least 6 characters';
      return;
    }
    if(newPassword !== newPassword2){
      errEl.textContent = 'New passwords do not match';
      return;
    }
    reauthenticateWithCredential(currentUser, EmailAuthProvider.credential(currentUser.email, currentPassword))
      .then(() => updatePassword(currentUser, newPassword))
      .then(() => {
        successEl.textContent = 'Password changed!';
        form.reset();
      })
      .catch(err => { errEl.textContent = authErrorMessage(err); });
  });
}

/* ---------- Data Management (Export/Import, moved out of the account
   dropdown itself — see the request that split this out) ---------- */
export function initDataManagementModal(){
  function openDataManagementModal(){
    document.getElementById('navbarAccount').classList.remove('open');
    document.getElementById('dataManagementModalOverlay').classList.add('open');
  }
  function closeDataManagementModal(){
    document.getElementById('dataManagementModalOverlay').classList.remove('open');
  }
  document.getElementById('btnOpenDataManagement').addEventListener('click', openDataManagementModal);
  document.getElementById('btnCloseDataManagement').addEventListener('click', closeDataManagementModal);
  wireModalOverlayClose('dataManagementModalOverlay', closeDataManagementModal);
}

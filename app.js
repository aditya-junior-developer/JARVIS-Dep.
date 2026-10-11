import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import { getDatabase, ref, set, update, onValue, onDisconnect, push, onChildAdded, serverTimestamp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-database.js';

const el = id => document.getElementById(id);
const errorBox = el('message');
const showError = error => {
  errorBox.hidden = false;
  errorBox.textContent = String(error?.message || error);
  console.error(error);
};
const clearError = () => { errorBox.hidden = true; errorBox.textContent = ''; };
const status = message => { el('callStatus').textContent = message; };

let auth, db, user = null;
let deviceId = localStorage.getItem('jarvis-call-device-id');
if (!deviceId) {
  deviceId = crypto.randomUUID();
  localStorage.setItem('jarvis-call-device-id', deviceId);
}
let deviceName = localStorage.getItem('jarvis-call-device-name') || '';
el('devName').value = deviceName;
let deviceRef = null, presenceStop = null, deviceStop = null, inboxStop = null;
let pc = null, mic = null, activeCall = null, incoming = null;
let callStops = [], pendingIce = [], candidateKeys = new Set();

const userRoot = () => 'users/' + user.uid;
function listenCall(target, callback) {
  callStops.push(onValue(target, callback, showError));
}
function stopCallListeners() {
  for (const stop of callStops) stop();
  callStops = [];
}
function resetCall() {
  stopCallListeners();
  if (pc) { pc.ontrack = null; pc.onicecandidate = null; pc.onconnectionstatechange = null; pc.close(); pc = null; }
  mic?.getTracks().forEach(track => track.stop()); mic = null;
  const audio = el('remoteAudio');
  audio.pause();
  audio.srcObject = null;
  audio.load();
  activeCall = null;
  incoming = null;
  pendingIce = [];
  candidateKeys = new Set();
  el('answer').disabled = true;
  el('hang').disabled = true;
  document.title = 'JARVIS · Device Calling';
  status('Idle');
}
function stopDeviceListeners() {
  presenceStop?.(); presenceStop = null;
  deviceStop?.(); deviceStop = null;
  inboxStop?.(); inboxStop = null;
}
function refreshUi() {
  el('login').hidden = !!user;
  el('logout').hidden = !user;
  el('register').disabled = !user;
  el('authState').textContent = user ? ('Signed in: ' + (user.email || 'Google account')) : 'Not signed in';
  if (!user) {
    el('devices').textContent = 'Sign in to see connected devices.';
    el('myDevice').textContent = 'Sign in to register this browser.';
  }
}
async function establishPeer() {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('Microphone unavailable. Open the page on HTTPS and allow microphone access.');
  }
  mic = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 }, video: false
  });
  // STUN-only proof of concept. Reliable cross-network calling also needs a TURN relay.
  pc = new RTCPeerConnection({ iceServers: [
    { urls: 'stun:stun.l.google.com:19302' }
  ] });
  mic.getTracks().forEach(track => pc.addTrack(track, mic));
  pc.ontrack = event => {
    if (event.track.kind !== 'audio') return;
    const audio = el('remoteAudio');
    const stream = event.streams[0] || new MediaStream([event.track]);
    // Avoid resetting the audio element for repeated track events.
    if (audio.srcObject !== stream) audio.srcObject = stream;
    audio.play().catch(() => status('Connected — tap Play to hear the call.'));
  };
  pc.onconnectionstatechange = () => {
    if (!pc) return;
    if (pc.connectionState === 'failed') {
      status('Connection failed. This network may require a TURN server.');
    } else {
      status('Connection: ' + pc.connectionState);
    }
  };
  return pc;
}
async function addRemoteCandidate(data) {
  if (!pc || !data) return;
  if (!pc.remoteDescription) {
    pendingIce.push(data);
    return;
  }
  try { await pc.addIceCandidate(data); }
  catch (error) { console.warn('ICE candidate rejected', error); }
}
async function flushIce() {
  while (pc?.remoteDescription && pendingIce.length) {
    await addRemoteCandidate(pendingIce.shift());
  }
}
function watchCandidates(path) {
  const unsubscribe = onChildAdded(ref(db, path), snapshot => {
    if (candidateKeys.has(snapshot.key)) return;
    candidateKeys.add(snapshot.key);
    addRemoteCandidate(snapshot.val()).catch(showError);
  }, showError);
  callStops.push(unsubscribe);
}
async function startCall(target, name) {
  if (!user || !deviceRef) return showError('Sign in and register this device first.');
  if (activeCall || incoming) return showError('End the current call before starting another.');
  clearError();
  const uid = user.uid;
  const callKey = push(ref(db, 'users/' + uid + '/calls/' + target)).key;
  const path = 'users/' + uid + '/calls/' + target + '/' + callKey;
  try {
    await establishPeer();
    activeCall = { path, peer: target };
    // Write the initial node BEFORE ICE candidate collection. Otherwise set()
    // could overwrite the early ICE candidate nodes and break the call.
    await set(ref(db, path), {
      from: deviceId, to: target, state: 'preparing', createdAt: serverTimestamp()
    });
    pc.onicecandidate = event => {
      if (event.candidate) {
        push(ref(db, path + '/offerCandidates'), event.candidate.toJSON()).catch(showError);
      }
    };
    watchCandidates(path + '/answerCandidates');
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await update(ref(db, path), {
      offer: { type: offer.type, sdp: offer.sdp }, state: 'ringing'
    });
    listenCall(ref(db, path + '/answer'), async snapshot => {
      if (!snapshot.exists() || !pc || pc.remoteDescription) return;
      try {
        await pc.setRemoteDescription(snapshot.val());
        await flushIce();
      } catch (error) { showError(error); }
    });
    listenCall(ref(db, path + '/state'), snapshot => {
      if (snapshot.val() === 'ended') resetCall();
    });
    el('hang').disabled = false;
    status('Calling ' + name + '…');
  } catch (error) {
    showError(error);
    await update(ref(db, path), { state: 'ended' }).catch(() => {});
    resetCall();
  }
}
async function answerCall() {
  if (!incoming || pc) return;
  clearError();
  const { id, call } = incoming;
  const path = userRoot() + '/calls/' + deviceId + '/' + id;
  el('answer').disabled = true;
  try {
    await establishPeer();
    activeCall = { path, peer: call.from };
    incoming = null;
    pc.onicecandidate = event => {
      if (event.candidate) {
        push(ref(db, path + '/answerCandidates'), event.candidate.toJSON()).catch(showError);
      }
    };
    watchCandidates(path + '/offerCandidates');
    await pc.setRemoteDescription(call.offer);
    await flushIce();
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await update(ref(db, path), {
      answer: { type: answer.type, sdp: answer.sdp }, state: 'connected'
    });
    listenCall(ref(db, path + '/state'), snapshot => {
      if (snapshot.val() === 'ended') resetCall();
    });
    status('Connecting…');
  } catch (error) {
    showError(error);
    await update(ref(db, path), { state: 'ended' }).catch(() => {});
    resetCall();
  }
}
async function hangUp() {
  const path = activeCall?.path || (incoming && userRoot() + '/calls/' + deviceId + '/' + incoming.id);
  if (path) await update(ref(db, path), { state: 'ended' }).catch(showError);
  resetCall();
}
function watchDevices() {
  deviceStop?.();
  deviceStop = onValue(ref(db, userRoot() + '/devices'), snapshot => {
    const root = el('devices');
    root.replaceChildren();
    const devices = Object.entries(snapshot.val() || {});
    if (!devices.length) {
      root.textContent = 'No registered devices yet.';
      return;
    }
    for (const [id, data] of devices) {
      const row = document.createElement('div');
      row.className = 'device';
      const label = document.createElement('div');
      label.className = 'device-title';
      const name = document.createElement('span');
      name.textContent = data.name || 'Unnamed device';
      const presence = document.createElement('small');
      presence.className = data.online ? 'online' : 'offline';
      presence.textContent = ' · ' + (data.online ? 'Online' : 'Offline') +
        (id === deviceId ? ' (this device)' : '');
      label.append(name, presence);
      row.append(label);
      if (id !== deviceId) {
        const callButton = document.createElement('button');
        callButton.textContent = 'Call';
        callButton.disabled = !data.online;
        callButton.onclick = () => startCall(id, data.name || 'device');
        row.append(callButton);
      }
      root.append(row);
    }
  }, showError);
}
function watchIncoming() {
  inboxStop?.();
  inboxStop = onValue(ref(db, userRoot() + '/calls/' + deviceId), snapshot => {
    if (activeCall) return;
    if (incoming) {
      const existing = snapshot.child(incoming.id).val();
      if (existing?.state === 'ringing') return;
      resetCall(); // Caller hung up before answer; release the Answer UI.
    }
    for (const [id, call] of Object.entries(snapshot.val() || {})) {
      const stale = typeof call.createdAt === 'number' && Date.now() - call.createdAt > 120000;
      if (call.state !== 'ringing' || !call.offer || call.from === deviceId || stale) continue;
      incoming = { id, call };
      el('answer').disabled = false;
      el('hang').disabled = false;
      status('Incoming call from device ' + String(call.from).slice(0, 8) + '…');
      document.title = 'Incoming call · JARVIS';
      navigator.vibrate?.([120, 80, 120]);
      break;
    }
  }, showError);
}
async function registerDevice() {
  if (!user) return showError('Sign in with Google first.');
  const name = el('devName').value.trim();
  if (!name) return showError('Enter a device name.');
  clearError();
  deviceName = name;
  localStorage.setItem('jarvis-call-device-name', name);
  deviceRef = ref(db, userRoot() + '/devices/' + deviceId);
  presenceStop?.();
  presenceStop = onValue(ref(db, '.info/connected'), async snapshot => {
    if (!snapshot.val() || !user || !deviceRef) return;
    try {
      await onDisconnect(deviceRef).update({ online: false, lastSeen: serverTimestamp() });
      await set(deviceRef, {
        name: deviceName, online: true, lastSeen: serverTimestamp()
      });
    } catch (error) { showError(error); }
  }, showError);
  el('myDevice').textContent = 'Paired: ' + name + ' (' + deviceId.slice(0, 8) + ')';
  watchDevices();
  watchIncoming();
}
async function boot() {
  try {
    const response = await fetch('/firebase-config.json', { cache: 'no-store' });
    if (!response.ok) throw new Error('Firebase configuration missing.');
    const config = await response.json();
    if (!config.apiKey || !config.authDomain || !config.databaseURL || !config.projectId) {
      throw new Error('Incomplete Firebase web configuration.');
    }
    const app = initializeApp(config);
    auth = getAuth(app);
    db = getDatabase(app);
    el('login').onclick = () => signInWithPopup(auth, new GoogleAuthProvider()).catch(showError);
    el('logout').onclick = async () => {
      try {
        if (activeCall || incoming) await hangUp();
        if (deviceRef) await update(deviceRef, { online: false, lastSeen: serverTimestamp() });
        await signOut(auth);
      } catch (error) { showError(error); }
    };
    el('register').onclick = registerDevice;
    el('answer').onclick = answerCall;
    el('hang').onclick = hangUp;
    onAuthStateChanged(auth, nextUser => {
      resetCall();
      stopDeviceListeners();
      deviceRef = null;
      user = nextUser;
      refreshUi();
      if (user && deviceName) {
        el('myDevice').textContent = 'Click Register device to come online.';
      }
      clearError();
    }, showError);
  } catch (error) {
    showError(error);
    el('authState').textContent = 'Setup needed';
  }
}
boot();

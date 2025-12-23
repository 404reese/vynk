import { useEffect, useRef, useState } from "react";
import "./App.css";

// Helper to get WS URL
const getWsUrl = (roomId) => {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const wsHost = window.location.hostname;
  return `${protocol}//${wsHost}:8000/ws/${roomId}`;
};

export default function App() {
  const localVideoRef = useRef(null);
  const remoteVideoRef = useRef(null);

  // Persistent Refs
  const pcRef = useRef(null);
  const socketRef = useRef(null);
  // We keep track of senders to use replaceTrack
  const audioSenderRef = useRef(null);
  const videoSenderRef = useRef(null);
  // Keep track of current local stream to stop it when needed
  const localStreamRef = useRef(null);

  const iceCandidatesQueue = useRef([]);
  const hasRemoteDescription = useRef(false);

  const [activeMode, setActiveMode] = useState("dashboard"); // "dashboard", "video", "chat"
  const [isMuted, setIsMuted] = useState(false);
  const [status, setStatus] = useState("idle");
  const [messages, setMessages] = useState([]);
  const [chatInput, setChatInput] = useState("");

  // derived from URL
  const [roomId] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get("room") || crypto.randomUUID();
  });
  const [isAdmin] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get("role") === "admin" || !params.get("room");
  });
  const [inviteLink, setInviteLink] = useState("");

  // --- Initialization ---

  // 1. Setup Link
  useEffect(() => {
    if (isAdmin) {
      setInviteLink(`${window.location.origin}?room=${roomId}`);
      const params = new URLSearchParams(window.location.search);
      if (!params.get("room")) {
        const newUrl = `${window.location.pathname}?room=${roomId}&role=admin`;
        window.history.replaceState(null, "", newUrl);
      }
    }
  }, [isAdmin, roomId]);

  // 2. Setup Persistent Connections (Socket + PC)
  useEffect(() => {
    // Connect WS
    const socket = new WebSocket(getWsUrl(roomId));
    socketRef.current = socket;

    socket.onopen = () => {
      console.log("WebSocket connected");
      setStatus("connected");
      // Flush ICE queue if any (unlikely this early but good practice)
      // Check if we need to initiate anything? 
      // If Admin, wait for offer. If User, we might offer later when mode videos.
    };

    socket.onmessage = handleSocketMessage;
    socket.onclose = () => setStatus("disconnected");

    // Setup PC
    const pc = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
    });
    pcRef.current = pc;

    // Add Transceivers immediately to establish "senders"
    // We add them as 'sendrecv' or 'recvonly' to ensure negotiation happens once.
    // If we are User, we want to send. Admin wants to receive.
    // Ideally 'sendrecv' is flexible.
    // We add them so track.replaceTrack works later without renegotiation.
    const audioTransceiver = pc.addTransceiver('audio', { direction: 'sendrecv' });
    const videoTransceiver = pc.addTransceiver('video', { direction: 'sendrecv' });

    audioSenderRef.current = audioTransceiver.sender;
    videoSenderRef.current = videoTransceiver.sender;

    // Remote Media Stream (Manually managed due to addTransceiver not syncing streams automatically without SDP tweaks)
    const remoteStream = new MediaStream();

    pc.ontrack = (event) => {
      const track = event.track;
      // Add track to our manual stream
      remoteStream.addTrack(track);

      // Attach this stream to the video element
      if (remoteVideoRef.current) {
        remoteVideoRef.current.srcObject = remoteStream;
      }

      // Cleanup on track removal/end
      track.onended = () => {
        remoteStream.removeTrack(track);
      };
    };

    pc.onicecandidate = (event) => {
      if (event.candidate && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "ice", candidate: event.candidate }));
      }
    };

    // User initiates negation immediately to establish the connection? 
    // Or wait for "Video" mode?
    // User constraint: "Reuse SINGLE ... Do NOT recreate ... "
    // If we wait, valid. But having the connection ready is better.
    // Let's create the offer now (with empty/dummy tracks from transceivers) 
    // so the pipe is ready.
    if (!isAdmin) {
      pc.onnegotiationneeded = async () => {
        try {
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type: "offer", offer }));
          } else {
            socket.addEventListener('open', () => socket.send(JSON.stringify({ type: "offer", offer })), { once: true });
          }
        } catch (e) { console.error(e); }
      };
    }

    return () => {
      socket.close();
      pc.close();
      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach(t => t.stop());
      }
    };
  }, [roomId, isAdmin]);


  // --- Logic ---

  const handleSocketMessage = async (event) => {
    const msg = JSON.parse(event.data);
    const pc = pcRef.current;

    switch (msg.type) {
      case "chat":
      case "image":
      case "file":
        setMessages(prev => [...prev, msg]);
        // Play notification sound
        try {
          const audio = new Audio("/tone.wav");
          audio.play().catch(e => console.warn("Audio play failed:", e));
        } catch (e) {
          console.error("Error playing sound:", e);
        }
        break;

      case "offer":
        if (isAdmin) {
          await pc.setRemoteDescription(msg.offer);
          hasRemoteDescription.current = true;
          processIceQueue(pc);
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          socketRef.current.send(JSON.stringify({ type: "answer", answer }));
        }
        break;

      case "answer":
        if (!isAdmin) {
          await pc.setRemoteDescription(msg.answer);
          hasRemoteDescription.current = true;
          processIceQueue(pc);
        }
        break;

      case "ice":
        if (hasRemoteDescription.current) {
          pc.addIceCandidate(msg.candidate).catch(e => console.error(e));
        } else {
          iceCandidatesQueue.current.push(msg.candidate);
        }
        break;
      default:
        break;
    }
  };

  const processIceQueue = async (pc) => {
    while (iceCandidatesQueue.current.length > 0) {
      await pc.addIceCandidate(iceCandidatesQueue.current.shift()).catch(e => console.error(e));
    }
  };

  // --- Mode Switching ---

  const toggleMute = () => {
    if (audioSenderRef.current && audioSenderRef.current.track) {
      const enabled = !audioSenderRef.current.track.enabled;
      audioSenderRef.current.track.enabled = !enabled ? true : false; // Toggle logic inverse check
      // Actually, simple toggle:
      audioSenderRef.current.track.enabled = !isMuted;
      setIsMuted(!isMuted);
    }
  };

  const switchMode = async (mode) => {
    setActiveMode(mode);
    const pc = pcRef.current;

    try {
      if (mode === "video") {
        // Combined Audio & Video
        const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });

        // Update local preview
        if (localVideoRef.current) localVideoRef.current.srcObject = stream;

        // Update Tracks
        const [videoTrack] = stream.getVideoTracks();
        const [audioTrack] = stream.getAudioTracks();

        if (videoSenderRef.current) {
          await videoSenderRef.current.replaceTrack(videoTrack);
          videoSenderRef.current.track.enabled = true;
        }
        if (audioSenderRef.current) {
          await audioSenderRef.current.replaceTrack(audioTrack);
          audioSenderRef.current.track.enabled = !isMuted; // Respect current mute state? Or reset?
          // Let's reset mute on fresh start of video mode for clarity, or keep it false.
          setIsMuted(false);
          audioSenderRef.current.track.enabled = true;
        }

        // Store to clean up later
        localStreamRef.current = stream;

      } else {
        // Chat Mode -> Disable Media
        if (videoSenderRef.current) await videoSenderRef.current.replaceTrack(null);
        if (audioSenderRef.current) await audioSenderRef.current.replaceTrack(null);

        if (localStreamRef.current) {
          localStreamRef.current.getTracks().forEach(t => t.stop());
          localStreamRef.current = null;
        }
        if (localVideoRef.current) localVideoRef.current.srcObject = null;
      }
    } catch (err) {
      console.error("Mode switch error:", err);
      alert("Could not access devices: " + err.message);
    }
  };

  // --- Chat & File Sending ---

  const sendChat = () => {
    if (!chatInput.trim()) return;
    const msg = { type: "chat", message: chatInput, sender: isAdmin ? "Admin" : "User" };
    socketRef.current.send(JSON.stringify(msg));
    setMessages(prev => [...prev, msg]);
    setChatInput("");
  };

  const handleFileUpload = (e, type) => {
    const file = e.target.files[0];
    if (!file) return;

    if (type === "image") {
      const reader = new FileReader();
      reader.onload = () => {
        const msg = { type: "image", name: file.name, data: reader.result, sender: isAdmin ? "Admin" : "User" };
        socketRef.current.send(JSON.stringify(msg));
        setMessages(prev => [...prev, msg]);
      };
      reader.readAsDataURL(file);
    } else {
      // File Mode (Placeholder as per MVP)
      const msg = { type: "file", name: file.name, size: file.size, sender: isAdmin ? "Admin" : "User" };
      socketRef.current.send(JSON.stringify(msg));
      setMessages(prev => [...prev, msg]);
    }
  };


  // --- UI Components ---

  return (
    <div className="app-container">
      {/* Header / Toolbar */}
      <header className="toolbar">
        <div className="status-bar">
          <span>{isAdmin ? "Admin" : "User"} | Status: {status}</span>
        </div>
        <div className="mode-selector">
          {['video', 'chat'].map(m => (
            <button
              key={m}
              className={activeMode === m ? 'active' : ''}
              onClick={() => switchMode(m)}
            >
              {m === 'video' ? 'Live Video' : 'Chat'}
            </button>
          ))}
        </div>
      </header>

      {/* Main Content Area */}
      <main className="content-area">

        {/* Media Placeholder - Always rendered for remote consistency, but hidden/styled based on mode */}
        <div className="media-container" style={{ display: (activeMode === 'video' || activeMode === 'audio' || activeMode === 'dashboard') ? 'flex' : 'none' }}>
          {/* Local Video (User) */}
          {!isAdmin && (
            <div className="video-wrapper local">
              <video ref={localVideoRef} autoPlay muted playsInline />
              <span className="label">You</span>
              {activeMode === 'video' && (
                <button className="mute-btn" onClick={toggleMute}>
                  {isMuted ? "Unmute" : "Mute"}
                </button>
              )}
            </div>
          )}

          {/* Remote Video (Admin/User) */}
          {/* Remote Video (Only visible to Admin) */}
          {isAdmin && (
            <div className="video-wrapper remote">
              <video ref={remoteVideoRef} autoPlay playsInline />
              <span className="label">User Feed</span>
            </div>
          )}
        </div>

        {/* Dashboard Landing */}
        {activeMode === 'dashboard' && (
          <div className="dashboard-intro">
            <h2>Welcome</h2>
            <p>Select a mode from the toolbar to start communication.</p>
            {isAdmin && <div className="invite-box">Invite Link: <input readOnly value={inviteLink} /></div>}
          </div>
        )}

        {/* Chat Interface - Only for Chat Mode */}
        {activeMode === 'chat' && (
          <div className="chat-interface">
            <div className="messages-list">
              {messages.map((m, i) => (
                <div key={i} className={`message-item ${m.sender === (isAdmin ? "Admin" : "User") ? 'mine' : 'theirs'}`}>
                  <span className="sender-name">{m.sender}</span>
                  {m.type === 'chat' && <p>{m.message}</p>}
                  {m.type === 'image' && <img src={m.data} alt={m.name} className="shared-image" />}
                  {m.type === 'file' && (
                    <div className="file-attachment">
                      📁 {m.name} <small>({Math.round(m.size / 1024)} KB)</small>
                    </div>
                  )}
                </div>
              ))}
            </div>

            {/* Unified Input Area */}
            <div className="input-area unified">
              <input
                value={chatInput}
                onChange={e => setChatInput(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && sendChat()}
                placeholder="Type message..."
              />
              <label className="icon-btn" title="Send Image">
                📷
                <input type="file" accept="image/*" onChange={(e) => handleFileUpload(e, 'image')} hidden />
              </label>
              <label className="icon-btn" title="Send File">
                📎
                <input type="file" onChange={(e) => handleFileUpload(e, 'file')} hidden />
              </label>
              <button onClick={sendChat}>Send</button>
            </div>
          </div>
        )}

      </main>
    </div>
  );
}

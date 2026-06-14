/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useRef, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import { motion, AnimatePresence } from 'motion/react';
import { 
  Video, VideoOff, Mic, MicOff, Send, RefreshCw, X, MessageSquare, Users, 
  Sparkles, ShieldAlert, Wifi, MonitorPlay, Keyboard, Disc, Flame, Star, Loader2, HelpCircle
} from 'lucide-react';
import { Message, ConnectionStatus } from './types';

export default function App() {
  const [socket, setSocket] = useState<Socket | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>('idle');
  const [userCount, setUserCount] = useState<number>(0);
  const [messages, setMessages] = useState<Message[]>([]);
  const [messageText, setMessageText] = useState<string>('');
  
  // Audio/Video control states
  const [videoEnabled, setVideoEnabled] = useState<boolean>(true);
  const [audioEnabled, setAudioEnabled] = useState<boolean>(true);
  
  // Media streams & connection state
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [partnerId, setPartnerId] = useState<string | null>(null);
  const [mediaError, setMediaError] = useState<string | null>(null);

  // Refs for video elements, socket, peer connection, & candidate queue
  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);
  const socketRef = useRef<Socket | null>(null);
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const partnerIdRef = useRef<string | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const candidateQueue = useRef<RTCIceCandidateInit[]>([]);
  const chatEndRef = useRef<HTMLDivElement | null>(null);

  // STUN Servers (Google public stun servers for instant NAT traversal)
  // For production, a Coturn or TURN service should be passed in iceServers, e.g.:
  // { urls: 'turn:my-turn-server.com', username: 'user', credential: 'password' }
  const PC_CONFIG = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19302' },
      { urls: 'stun:stun3.l.google.com:19302' },
      { urls: 'stun:stun4.l.google.com:19302' }
    ]
  };

  // Synchronize local video element with localStream state
  useEffect(() => {
    if (localVideoRef.current) {
      localVideoRef.current.srcObject = localStream;
    }
  }, [localStream, status]);

  // Synchronize remote video element with remoteStream state
  useEffect(() => {
    if (remoteVideoRef.current) {
      remoteVideoRef.current.srcObject = remoteStream;
    }
  }, [remoteStream, status]);

  // 1. Initialize socket connection
  useEffect(() => {
    // Establish connection to same site host (extremely safe for proxy environments)
    const socketInstance = io({
      transports: ['websocket'],
      upgrade: false
    });
    socketRef.current = socketInstance;
    setSocket(socketInstance);

    // Initial user count request
    socketInstance.emit('get-user-count');

    // Register general state receivers
    socketInstance.on('user-count', (data: { count: number }) => {
      setUserCount(data.count);
    });

    socketInstance.on('status', (data: { status: 'idle' | 'waiting' }) => {
      if (data.status === 'idle') setStatus('idle');
      if (data.status === 'waiting') setStatus('waiting');
    });

    socketInstance.on('match', async (data: { partnerId: string; initiator: boolean }) => {
      console.log('Match received:', data);
      setPartnerId(data.partnerId);
      partnerIdRef.current = data.partnerId;
      setStatus('chatting');
      
      // Clear legacy message lists for the new session
      setMessages([
        {
          id: 'sys-start',
          sender: 'system',
          text: 'Connected with a random partner! Say hello.',
          timestamp: Date.now()
        }
      ]);

      // Create WebRTC peer connection
      setupPeerConnection(data.partnerId, data.initiator);
    });

    socketInstance.on('partner-disconnected', () => {
      console.log('Partner disconnected');
      addSystemMessage('Your partner has disconnected. Press "Next" to find a new partner.');
      setStatus('disconnected');
      stopPeerConnection();
    });

    socketInstance.on('signal', async (data: { from: string; signal: any }) => {
      // Basic security check: packet must be from our designated matched partner
      if (data.from !== partnerIdRef.current) return;
      
      const pc = peerConnectionRef.current;
      if (!pc) return;

      try {
        if (data.signal.sdp) {
          await pc.setRemoteDescription(new RTCSessionDescription(data.signal.sdp));
          
          if (data.signal.sdp.type === 'offer') {
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            socketInstance.emit('signal', {
              to: data.from,
              signal: { sdp: pc.localDescription }
            });
          }

          // Process and flush socket-queued ice candidates
          candidateQueue.current.forEach(candidate => {
            pc.addIceCandidate(new RTCIceCandidate(candidate))
              .catch(err => console.error('Error adding queued ICE Candidate:', err));
          });
          candidateQueue.current = [];
        } else if (data.signal.candidate) {
          if (pc.remoteDescription) {
            await pc.addIceCandidate(new RTCIceCandidate(data.signal.candidate));
          } else {
            candidateQueue.current.push(data.signal.candidate);
          }
        }
      } catch (error) {
        console.error('Failed processing signaling payload:', error);
      }
    });

    socketInstance.on('message', (msg: { text: string; sender: 'partner'; timestamp: number }) => {
      setMessages(prev => [
        ...prev,
        {
          id: Math.random().toString(),
          sender: 'partner',
          text: msg.text,
          timestamp: msg.timestamp
        }
      ]);
    });

    // Cleanup logic
    return () => {
      socketInstance.disconnect();
      stopLocalStream();
      stopPeerConnection();
    };
  }, []);

  // Sync scroll on chat history changes
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Handle hotkeys (Escape to instantly trigger matching/skip)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        const isTyping = document.activeElement?.tagName === 'INPUT' || document.activeElement?.tagName === 'TEXTAREA';
        if (!isTyping) {
          e.preventDefault();
          if (status === 'chatting' || status === 'waiting' || status === 'disconnected') {
            handleNextPartner();
          }
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [status, localStream]);

  // 2. Request user media capture stream
  const obtainMediaStream = async (): Promise<MediaStream | null> => {
    if (localStreamRef.current) return localStreamRef.current;

    try {
      setMediaError(null);
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 640 },
          height: { ideal: 480 },
          facingMode: 'user'
        },
        audio: true
      });
      
      setLocalStream(stream);
      localStreamRef.current = stream;
      
      // Bind to local video preview layer
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = stream;
      }
      return stream;
    } catch (err: any) {
      console.warn('Microphone or Camera access declined:', err);
      let errorMsg = 'Could not access camera/mic. Utilizing text-only capabilities.';
      if (err.name === 'NotAllowedError') {
        errorMsg = 'Camera and microphone access requested but denied. Please check site permissions.';
      } else if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
        errorMsg = 'No audio or video input devices detected.';
      }
      setMediaError(errorMsg);
      return null;
    }
  };

  const stopLocalStream = () => {
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach(track => track.stop());
      localStreamRef.current = null;
      setLocalStream(null);
    }
  };

  // 3. WebRTC peer connection configuration
  const setupPeerConnection = async (partnerSocketId: string, initiator: boolean) => {
    try {
      const pc = new RTCPeerConnection(PC_CONFIG);
      peerConnectionRef.current = pc;

      // Handle remote media track bindings
      pc.ontrack = (event) => {
        console.log('Received remote track', event.streams);
        if (event.streams && event.streams[0]) {
          setRemoteStream(event.streams[0]);
        }
      };

      // Handle local media ICE discovery candidates
      pc.onicecandidate = (event) => {
        if (event.candidate && socketRef.current) {
          socketRef.current.emit('signal', {
            to: partnerSocketId,
            signal: { candidate: event.candidate }
          });
        }
      };

      // Diagnostic logs for Ice troubleshooting
      pc.oniceconnectionstatechange = () => {
        console.log('ICE connection state is:', pc.iceConnectionState);
        if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'disconnected') {
          console.warn('ICE connection disconnected or failed, closing session.');
        }
      };

      // Get (or prompt for) permission streams in background
      let currentStream = localStreamRef.current;
      if (!currentStream) {
        currentStream = await obtainMediaStream();
      }

      // Add local track feeds to the transport peer connection
      if (currentStream) {
        currentStream.getTracks().forEach((track) => {
          if (currentStream) {
            pc.addTrack(track, currentStream);
          }
        });
      }

      // Initiator generates RTC Offer
      if (initiator) {
        const offer = await pc.createOffer({
          offerToReceiveAudio: true,
          offerToReceiveVideo: true
        });
        await pc.setLocalDescription(offer);
        socketRef.current?.emit('signal', {
          to: partnerSocketId,
          signal: { sdp: pc.localDescription }
        });
      }
    } catch (error) {
      console.error('Failed initializing peer connection handshake:', error);
      addSystemMessage('Handshake failure. Please restart search.');
    }
  };

  const stopPeerConnection = () => {
    const pc = peerConnectionRef.current;
    if (pc) {
      pc.onicecandidate = null;
      pc.ontrack = null;
      pc.oniceconnectionstatechange = null;
      pc.close();
      peerConnectionRef.current = null;
    }
    setRemoteStream(null);
    if (remoteVideoRef.current) {
      remoteVideoRef.current.srcObject = null;
    }
    candidateQueue.current = [];
    partnerIdRef.current = null;
    setPartnerId(null);
  };

  // Helper system status notification
  const addSystemMessage = (text: string) => {
    setMessages(prev => [
      ...prev,
      {
        id: Math.random().toString(),
        sender: 'system',
        text,
        timestamp: Date.now()
      }
    ]);
  };

  // 4. Controller Handlers
  const handleStartChat = async () => {
    setStatus('waiting');
    addSystemMessage('Looking for a random online user...');
    
    // Attempt camera warmup automatically
    await obtainMediaStream();
    
    socketRef.current?.emit('join-queue');
  };

  const handleNextPartner = async () => {
    // Clear state
    stopPeerConnection();
    setStatus('waiting');
    setMessages([
      {
        id: 'sys-searching',
        sender: 'system',
        text: 'Searching for a new partner...',
        timestamp: Date.now()
      }
    ]);

    // Ensure camera stream stays warm or spins up
    await obtainMediaStream();

    // Re-request matchmaking
    socketRef.current?.emit('join-queue');
  };

  const handleLeaveChat = () => {
    stopPeerConnection();
    socketRef.current?.emit('leave-queue');
    socketRef.current?.emit('disconnect-partner');
    setStatus('idle');
    setMessages([
      {
        id: 'sys-end',
        sender: 'system',
        text: 'Chat session closed.',
        timestamp: Date.now()
      }
    ]);
  };

  const handleSendMessage = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!messageText.trim() || !socketRef.current) return;

    // Send via socket.io client
    socketRef.current.emit('send-message', { text: messageText.trim() });

    // Render immediately locally
    setMessages(prev => [
      ...prev,
      {
        id: Math.random().toString(),
        sender: 'me',
        text: messageText.trim(),
        timestamp: Date.now()
      }
    ]);
    
    setMessageText('');
  };

  // 5. Track toggle controllers
  const toggleVideo = () => {
    const nextVal = !videoEnabled;
    setVideoEnabled(nextVal);
    if (localStreamRef.current) {
      localStreamRef.current.getVideoTracks().forEach(track => {
        track.enabled = nextVal;
      });
    }
  };

  const toggleAudio = () => {
    const nextVal = !audioEnabled;
    setAudioEnabled(nextVal);
    if (localStreamRef.current) {
      localStreamRef.current.getAudioTracks().forEach(track => {
        track.enabled = nextVal;
      });
    }
  };

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 flex flex-col font-sans selection:bg-rose-500 selection:text-white">
      
      {/* HEADER BAR */}
      <header className="border-b border-zinc-900 bg-zinc-950/80 backdrop-blur-md sticky top-0 z-50 px-4 py-3 shrink-0 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="h-9 w-9 rounded-xl bg-gradient-to-tr from-rose-500 to-indigo-600 flex items-center justify-center shadow-lg shadow-rose-500/10">
            <Video className="h-5 w-5 text-white animate-pulse" />
          </div>
          <div>
            <h1 className="text-base font-semibold tracking-tight text-white flex items-center gap-2">
              Instant Chat <span className="text-[10px] uppercase tracking-widest bg-rose-500/15 text-rose-400 px-1.5 py-0.5 rounded-md font-mono">Live</span>
            </h1>
            <p className="text-[11px] text-zinc-500">Omegle-style 1-to-1 video matchmaking</p>
          </div>
        </div>

        {/* Dynamic State Banner */}
        <div className="flex items-center gap-4">
          <div className="hidden sm:flex items-center gap-2 bg-zinc-900/60 border border-zinc-800 rounded-full px-3 py-1 text-xs">
            <Users className="h-3.5 w-3.5 text-rose-500" />
            <span className="font-medium text-zinc-300 font-mono">{userCount}</span>
            <span className="text-zinc-500 text-[11px]">users online</span>
          </div>

          <div className="flex items-center gap-1.5 bg-green-500/10 border border-green-500/20 px-2.5 py-1 rounded-full text-[11px] text-green-400 font-medium">
            <span className="h-1.5 w-1.5 rounded-full bg-green-400 animate-ping" />
            <span>Systems Normal</span>
          </div>
        </div>
      </header>

      {/* CORE FRAME LAYOUT */}
      <main className="flex-1 overflow-hidden flex flex-col lg:flex-row h-full">
        
        {/* LEFT COMPASS: Video Area */}
        <section className="flex-1 bg-zinc-950 flex flex-col relative min-h-[350px] lg:min-h-0 border-r border-zinc-900">
          
          <div className="flex-1 relative overflow-hidden bg-zinc-900/40 p-4 flex items-center justify-center">
            
            <AnimatePresence mode="wait">
              
              {/* IDLE VIEW */}
              {status === 'idle' && (
                <motion.div 
                  initial={{ opacity: 0, y: 15 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -15 }}
                  className="max-w-md w-full bg-zinc-900/50 backdrop-blur-sm border border-zinc-900 rounded-3xl p-6 text-center shadow-xl space-y-6"
                >
                  <div className="inline-flex h-16 w-16 rounded-2xl bg-gradient-to-tr from-indigo-500 to-rose-500 items-center justify-center shadow-lg shadow-indigo-500/15">
                    <MonitorPlay className="h-8 w-8 text-white" />
                  </div>
                  
                  <div className="space-y-2">
                    <h2 className="text-xl font-semibold text-white tracking-tight">Meet Random Strangers</h2>
                    <p className="text-sm text-zinc-400 px-4 leading-relaxed">
                      Instant 1-to-1 video, voice, and text chat. You are matched randomly with another online stranger.
                    </p>
                  </div>

                  {mediaError && (
                    <div className="mx-2 bg-amber-500/10 border border-amber-500/20 rounded-xl p-3 text-left flex gap-2 text-xs text-amber-400">
                      <ShieldAlert className="h-4 w-4 shrink-0 mt-0.5" />
                      <span>{mediaError}</span>
                    </div>
                  )}

                  <div className="pt-2">
                    <button
                      onClick={handleStartChat}
                      className="w-full bg-gradient-to-r from-rose-500 to-indigo-600 hover:opacity-90 active:scale-[0.98] transition-all text-white font-medium py-3.5 px-6 rounded-xl flex items-center justify-center gap-2.5 shadow-lg shadow-rose-500/15"
                    >
                      <Sparkles className="h-4 w-4" />
                      <span>Start Matching Live</span>
                    </button>
                  </div>

                  <div className="flex justify-around items-center pt-4 border-t border-zinc-800/60 text-xs text-zinc-500">
                    <span className="flex items-center gap-1"><ShieldAlert className="h-3 w-3" /> Anonymous</span>
                    <span className="flex items-center gap-1"><Wifi className="h-3 w-3" /> Low Latency</span>
                    <span className="flex items-center gap-1"><Keyboard className="h-3 w-3" /> Esc to Skip</span>
                  </div>
                </motion.div>
              )}

              {/* WAITING VIEW (RADAR REELS) */}
              {status === 'waiting' && (
                <motion.div 
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  className="flex flex-col items-center justify-center space-y-8 absolute inset-0"
                >
                  {/* Glowing Radar animation */}
                  <div className="relative h-44 w-44 flex items-center justify-center">
                    <motion.div 
                      animate={{ scale: [1, 2.2], opacity: [0.4, 0] }}
                      transition={{ repeat: Infinity, duration: 2.5, ease: "easeOut" }}
                      className="absolute inset-0 rounded-full border border-rose-500/30 bg-rose-500/5"
                    />
                    <motion.div 
                      animate={{ scale: [1, 1.7], opacity: [0.5, 0] }}
                      transition={{ repeat: Infinity, duration: 2.5, delay: 0.8, ease: "easeOut" }}
                      className="absolute inset-4 rounded-full border border-indigo-500/30 bg-indigo-500/5"
                    />
                    <motion.div 
                      animate={{ scale: [1, 1.3], opacity: [0.6, 0] }}
                      transition={{ repeat: Infinity, duration: 2.5, delay: 1.6, ease: "easeOut" }}
                      className="absolute inset-8 rounded-full border border-pink-500/30 bg-pink-500/5"
                    />
                    
                    <div className="h-16 w-16 rounded-full bg-gradient-to-tr from-rose-500 to-indigo-600 flex items-center justify-center shadow-2xl relative z-10 border border-white/10">
                      <Loader2 className="h-7 w-7 text-white animate-spin" />
                    </div>
                  </div>

                  <div className="text-center space-y-1.5 z-10 px-4">
                    <p className="text-sm font-medium text-zinc-200">Searching for an available partner...</p>
                    <p className="text-xs text-zinc-500 font-mono">Current match queue size: {userCount} online</p>
                  </div>

                  <button
                    onClick={handleLeaveChat}
                    className="z-10 bg-zinc-900 border border-zinc-800 hover:bg-zinc-800 text-zinc-300 font-medium py-2 px-6 rounded-full text-xs transition duration-200"
                  >
                    Cancel Search
                  </button>
                </motion.div>
              )}

              {/* CHATTING VIEW (VIDEO CONTAINERGRID) */}
              {(status === 'chatting' || status === 'disconnected') && (
                <motion.div 
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  className="absolute inset-0 p-4 flex flex-col md:flex-row gap-4 h-full"
                >
                  
                  {/* REMOTE STREAM (FULL PANEL OR PRIMARY CONTAINER) */}
                  <div className="flex-1 bg-black rounded-2xl overflow-hidden relative border border-zinc-900 shadow-xl flex items-center justify-center">
                    <video
                      ref={remoteVideoRef}
                      autoPlay
                      playsInline
                      className="w-full h-full object-cover"
                    />

                    {/* Remote fallback if stream tracks not connected yet */}
                    {(!remoteVideoRef.current?.srcObject) && (
                      <div className="absolute inset-0 flex flex-col items-center justify-center bg-zinc-900 space-y-3 z-0">
                        <div className="h-12 w-12 rounded-xl bg-zinc-800 flex items-center justify-center">
                          <Users className="h-6 w-6 text-zinc-500" />
                        </div>
                        <div className="text-center">
                          <p className="text-sm font-medium text-zinc-300">Establishing peer transport...</p>
                          <p className="text-xs text-zinc-500">Connecting WebRTC video socket streams</p>
                        </div>
                      </div>
                    )}

                    {/* Partner ID Indicator */}
                    <div className="absolute top-4 left-4 bg-black/55 backdrop-blur-md border border-zinc-800/80 text-[11px] px-3 py-1.5 rounded-full font-mono font-medium flex items-center gap-2 text-zinc-300">
                      <span className="h-1.5 w-1.5 rounded-full bg-rose-500 animate-pulse" />
                      <span>Partner ID: {partnerId?.slice(0, 8)}...</span>
                    </div>

                    {status === 'disconnected' && (
                      <div className="absolute inset-0 bg-zinc-950/85 backdrop-blur-xs flex flex-col items-center justify-center p-6 text-center z-20">
                        <div className="h-12 w-12 rounded-full bg-rose-500/10 border border-rose-500/20 text-rose-400 flex items-center justify-center mb-4">
                          <X className="h-6 w-6" />
                        </div>
                        <h3 className="text-base font-semibold text-white">Partner Disconnected</h3>
                        <p className="text-xs text-zinc-400 max-w-xs mt-1.5 leading-relaxed">
                          Your matched friend closed the chat window or skipped. Press 'Next Partner' to keep going.
                        </p>
                      </div>
                    )}

                    {/* LOCAL STREAM FLOATING OVERVIEW */}
                    <div className="absolute bottom-4 right-4 w-28 h-36 md:w-36 md:h-48 bg-zinc-950 rounded-xl overflow-hidden border border-zinc-800 shadow-2xl z-20">
                      <video
                        ref={localVideoRef}
                        autoPlay
                        playsInline
                        muted
                        className="w-full h-full object-cover scale-x-[-1]" // mirror effect
                      />
                      
                      {/* Local Track overlay controls indicators */}
                      <div className="absolute bottom-2 left-2 flex gap-1">
                        {!videoEnabled && (
                          <span className="bg-rose-500/90 text-white p-1 rounded-md text-[9px] font-semibold">
                            <VideoOff className="h-2.5 w-2.5" />
                          </span>
                        )}
                        {!audioEnabled && (
                          <span className="bg-rose-500/90 text-white p-1 rounded-md text-[9px] font-semibold">
                            <MicOff className="h-2.5 w-2.5" />
                          </span>
                        )}
                      </div>

                      <div className="absolute top-2 right-2 bg-black/40 backdrop-blur-md px-1.5 py-0.5 rounded text-[9px] text-zinc-300 font-mono">
                        You
                      </div>
                    </div>
                  </div>
                </motion.div>
              )}

            </AnimatePresence>

          </div>

          {/* LOWER CONTROL BAR */}
          <footer className="border-t border-zinc-900 bg-zinc-950/80 backdrop-blur px-4 py-3 shrink-0 flex flex-wrap gap-2 items-center justify-between z-30">
            <div className="flex items-center gap-1.5">
              
              {/* VIDEO ENABLE TOGGLE */}
              <button
                disabled={status === 'idle'}
                onClick={toggleVideo}
                className={`p-2.5 rounded-xl transition ${
                  !videoEnabled
                    ? 'bg-rose-500 text-white hover:bg-rose-600'
                    : 'bg-zinc-900 border border-zinc-800 text-zinc-300 hover:bg-zinc-800 disabled:opacity-40'
                }`}
                title={videoEnabled ? 'Disable Camera' : 'Enable Camera'}
              >
                {videoEnabled ? <Video className="h-4 w-4" /> : <VideoOff className="h-4 w-4" />}
              </button>

              {/* AUDIO ENABLE TOGGLE */}
              <button
                disabled={status === 'idle'}
                onClick={toggleAudio}
                className={`p-2.5 rounded-xl transition ${
                  !audioEnabled
                    ? 'bg-rose-500 text-white hover:bg-rose-600'
                    : 'bg-zinc-900 border border-zinc-800 text-zinc-300 hover:bg-zinc-800 disabled:opacity-40'
                }`}
                title={audioEnabled ? 'Mute Microphone' : 'Unmute Microphone'}
              >
                {audioEnabled ? <Mic className="h-4 w-4" /> : <MicOff className="h-4 w-4" />}
              </button>

              {(status === 'chatting' || status === 'disconnected') && (
                <button
                  onClick={handleLeaveChat}
                  className="bg-zinc-900 border border-rose-950/50 text-rose-400 hover:bg-rose-950/20 px-4 py-2 rounded-xl text-xs font-semibold transition"
                >
                  Leave Chat
                </button>
              )}
            </div>

            {/* MAIN ACTION: Skip / Next / Match buttons */}
            <div className="flex items-center gap-3">
              {(status === 'chatting' || status === 'waiting' || status === 'disconnected') ? (
                <div className="flex items-center gap-2">
                  <span className="hidden md:flex text-[10px] text-zinc-500 font-mono items-center gap-1">
                    <Keyboard className="h-3 w-3" /> Press <kbd className="bg-zinc-900 border border-zinc-800 px-1.5 py-0.5 rounded font-bold">Esc</kbd> to Skip
                  </span>
                  <button
                    onClick={handleNextPartner}
                    className="bg-rose-500 hover:bg-rose-600 active:scale-[0.98] text-white px-5 py-2.5 rounded-xl text-xs font-semibold flex items-center gap-2 transition shadow-lg shadow-rose-500/10"
                  >
                    <RefreshCw className="h-3.5 w-3.5" />
                    <span>Next Partner</span>
                  </button>
                </div>
              ) : (
                <button
                  onClick={handleStartChat}
                  className="bg-indigo-600 hover:bg-indigo-700 hover:shadow-indigo-600/10 hover:shadow-lg text-white px-5 py-2.5 rounded-xl text-xs font-semibold flex items-center gap-2 transition"
                >
                  <Sparkles className="h-3.5 w-3.5 animate-pulse" />
                  <span>Connect with Stranger</span>
                </button>
              )}
            </div>
          </footer>
        </section>

        {/* RIGHT PANEL: Messaging & Chat Area */}
        <section className="w-full lg:w-96 bg-zinc-950/90 flex flex-col shrink-0 h-[400px] lg:h-auto">
          
          {/* Side Bar Header */}
          <div className="px-4 py-3.5 border-b border-zinc-900 bg-zinc-950/80 flex items-center justify-between shrink-0">
            <h2 className="text-xs font-bold text-white tracking-widest uppercase flex items-center gap-2">
              <MessageSquare className="h-3.5 w-3.5 text-rose-500" />
              <span>Live Chatroom</span>
            </h2>
            <div className="text-[10px] font-mono text-zinc-500 uppercase">
              {status === 'chatting' ? 'Secured P2P' : 'Offline'}
            </div>
          </div>

          {/* Chat history messages context */}
          <div className="flex-1 overflow-y-auto p-4 space-y-4 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-zinc-800">
            {messages.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center p-6 text-center text-zinc-600">
                <MessageSquare className="h-8 w-8 mb-2 opacity-35" />
                <p className="text-xs font-medium">No messages currently.</p>
                <p className="text-[10px]">Start finding partners to activate live messaging.</p>
              </div>
            ) : (
              messages.map((msg) => {
                if (msg.sender === 'system') {
                  return (
                    <div key={msg.id} className="flex justify-center my-2">
                      <div className="bg-zinc-900 border border-zinc-800 text-[11px] text-zinc-400 py-1.5 px-3 rounded-full text-center select-none font-medium leading-normal max-w-[85%]">
                        {msg.text}
                      </div>
                    </div>
                  );
                }

                const isMe = msg.sender === 'me';
                return (
                  <div key={msg.id} className={`flex ${isMe ? 'justify-end' : 'justify-start'}`}>
                    <div className="flex flex-col max-w-[80%]">
                      {/* Message Bubble */}
                      <div className={`px-3.5 py-2.5 rounded-2xl text-xs leading-relaxed space-y-1 ${
                        isMe 
                          ? 'bg-rose-500 text-white rounded-tr-none shadow-md shadow-rose-500/10' 
                          : 'bg-zinc-900 border border-zinc-800 text-zinc-200 rounded-tl-none'
                      }`}>
                        <p className="break-words white-space-pre-wrap">{msg.text}</p>
                      </div>
                      
                      <span className={`text-[9px] text-zinc-600 font-mono mt-1 px-1 ${
                        isMe ? 'text-right' : 'text-left'
                      }`}>
                        {new Date(msg.timestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
                      </span>
                    </div>
                  </div>
                );
              })
            )}
            <div ref={chatEndRef} />
          </div>

          {/* Chat text box entry */}
          <form 
            onSubmit={handleSendMessage}
            className="p-3 border-t border-zinc-900 bg-zinc-950/50 shrink-0"
          >
            <div className="relative flex items-center">
              <input
                type="text"
                value={messageText}
                onChange={(e) => setMessageText(e.target.value)}
                placeholder={status === 'chatting' ? "Type a message here..." : "Start pairing first to send message..."}
                disabled={status !== 'chatting'}
                className="w-full bg-zinc-900/60 disabled:bg-zinc-900/10 border border-zinc-800 rounded-xl py-3 px-4 text-xs text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-rose-500/60 focus:ring-1 focus:ring-rose-500/60 transition disabled:cursor-not-allowed pr-12"
              />
              <button
                type="submit"
                disabled={status !== 'chatting' || !messageText.trim()}
                className="absolute right-2.5 p-1.5 rounded-lg bg-rose-500 disabled:bg-zinc-800 text-white disabled:text-zinc-600 hover:bg-rose-600 active:scale-95 transition"
              >
                <Send className="h-3.5 w-3.5" />
              </button>
            </div>
          </form>

        </section>

      </main>
    </div>
  );
}

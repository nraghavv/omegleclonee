export interface Message {
  id: string;
  sender: 'me' | 'partner' | 'system';
  text: string;
  timestamp: number;
}

export type ConnectionStatus = 'idle' | 'waiting' | 'chatting' | 'disconnected';

export interface SignalPayload {
  candidate?: RTCIceCandidateInit;
  sdp?: RTCSessionDescriptionInit;
}

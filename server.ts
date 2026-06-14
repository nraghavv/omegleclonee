import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import { Server as SocketIOServer } from "socket.io";
import http from "http";

async function startServer() {
  const app = express();
  const PORT = 3000;
  
  // Create HTTP server
  const server = http.createServer(app);
  
  // Attach Socket.io
  const io = new SocketIOServer(server, {
    cors: {
      origin: "*",
      methods: ["GET", "POST"]
    }
  });

  // Keep track of connected users
  const users = new Map<string, {
    id: string;
    state: 'idle' | 'waiting' | 'chatting';
    partnerId: string | null;
  }>();

  // Queue of waiting users
  const waitingQueue: string[] = [];

  io.on('connection', (socket) => {
    // Monitor connection
    users.set(socket.id, {
      id: socket.id,
      state: 'idle',
      partnerId: null
    });

    console.log(`[Socket] User connected: ${socket.id}`);

    // Helper to complete matchmaking if possible
    function tryMatchmaking(socketId: string) {
      const user = users.get(socketId);
      if (!user || user.state === 'chatting') return;

      // Remove self from the queue just in case
      const idx = waitingQueue.indexOf(socketId);
      if (idx !== -1) {
        waitingQueue.splice(idx, 1);
      }

      // Try to find an available idle/waiting partner
      while (waitingQueue.length > 0) {
        const potentialPartnerId = waitingQueue.shift();
        if (!potentialPartnerId) continue;

        const partner = users.get(potentialPartnerId);
        
        // Ensure partner is still active, waiting, and is not ourselves
        if (partner && partner.state === 'waiting' && potentialPartnerId !== socketId) {
          // Found match!
          user.state = 'chatting';
          user.partnerId = potentialPartnerId;

          partner.state = 'chatting';
          partner.partnerId = socketId;

          // Notify both peers of the match
          // We designate the newcomer as initiator, and the older waiting user as receiver
          socket.emit('match', {
            partnerId: potentialPartnerId,
            initiator: true // Will execute peerConnection.createOffer()
          });

          io.to(potentialPartnerId).emit('match', {
            partnerId: socketId,
            initiator: false // Will wait for peerConnection offer
          });

          console.log(`[Socket] Matched initiator ${socketId} with receiver ${potentialPartnerId}`);
          return;
        }
      }

      // If no valid partner, put this user back in queue
      user.state = 'waiting';
      waitingQueue.push(socketId);
      socket.emit('status', { status: 'waiting' });
      console.log(`[Socket] User ${socketId} queued. Queue size: ${waitingQueue.length}`);
    }

    // User joins queue to find random partner
    socket.on('join-queue', () => {
      const user = users.get(socket.id);
      if (!user) return;

      // If already chatted, leave current partner safely first
      if (user.partnerId) {
        disconnectPartner(socket.id);
      }

      tryMatchmaking(socket.id);
    });

    // User leaves queue
    socket.on('leave-queue', () => {
      const user = users.get(socket.id);
      if (!user) return;

      const idx = waitingQueue.indexOf(socket.id);
      if (idx !== -1) {
        waitingQueue.splice(idx, 1);
      }
      user.state = 'idle';
      socket.emit('status', { status: 'idle' });
      console.log(`[Socket] User ${socket.id} left queue. Queue size: ${waitingQueue.length}`);
    });

    // Helper to disconnect and reset a active matchmaking session
    function disconnectPartner(id: string) {
      const user = users.get(id);
      if (!user || !user.partnerId) return;

      const partnerId = user.partnerId;
      const partner = users.get(partnerId);

      // Reset partner state
      if (partner) {
        partner.state = 'idle';
        partner.partnerId = null;
        io.to(partnerId).emit('partner-disconnected');
      }

      // Reset user state
      user.state = 'idle';
      user.partnerId = null;
      socket.emit('partner-disconnected');
    }

    socket.on('disconnect-partner', () => {
      disconnectPartner(socket.id);
    });

    // Signalling mechanism for WebRTC (ICE candidates, Offer/Answer Exchange)
    socket.on('signal', (data: { to: string; signal: any }) => {
      const user = users.get(socket.id);
      // Security check: must be signaling with their actual current partner
      if (!user || user.partnerId !== data.to) return;
      
      io.to(data.to).emit('signal', {
        from: socket.id,
        signal: data.signal
      });
    });

    // Direct chat message relaying
    socket.on('send-message', (data: { text: string }) => {
      const user = users.get(socket.id);
      if (!user || !user.partnerId) return;

      io.to(user.partnerId).emit('message', {
        text: data.text,
        sender: 'partner',
        timestamp: Date.now()
      });
    });

    // Basic count of active users
    socket.on('get-user-count', () => {
      socket.emit('user-count', { count: users.size });
    });

    // Connection breakdown
    socket.on('disconnect', () => {
      console.log(`[Socket] User disconnected: ${socket.id}`);
      
      const user = users.get(socket.id);
      if (user) {
        // Remove from waiting queue if they were there
        const idx = waitingQueue.indexOf(socket.id);
        if (idx !== -1) {
          waitingQueue.splice(idx, 1);
        }

        // Notify active partner if chatting
        if (user.partnerId) {
          const partner = users.get(user.partnerId);
          if (partner) {
            partner.state = 'idle';
            partner.partnerId = null;
            io.to(user.partnerId).emit('partner-disconnected');
          }
        }
      }

      users.delete(socket.id);
    });
  });

  // Global user status check timer
  setInterval(() => {
    io.emit('user-count', { count: io.engine.clientsCount });
  }, 10000);

  // Vite development vs production router
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  // Listen strictly on configured container specifications
  server.listen(PORT, "0.0.0.0", () => {
    console.log(`[Server] Production Node/Socket.io/Express running on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error("[ServerError] Critical boot error:", err);
});

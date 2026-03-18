import express from 'express';
import { config } from './config.js';
import sdkRoutes from './routes/sdk.js';
import adminRoutes from './routes/admin.js';
import internalRoutes from './routes/internal.js';

const app = express();

app.use(express.json());
app.use(express.static('public'));

// Routes
app.use('/api/paywall', sdkRoutes);
app.use('/api/admin', adminRoutes);
app.use('/internal', internalRoutes);

// Also mount health at root for Cloud Run
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

app.listen(config.PORT, () => {
  console.log(`[PaywallOptimizer] Running on port ${config.PORT}`);
});

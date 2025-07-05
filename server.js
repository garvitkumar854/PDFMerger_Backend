const express = require('express');
const cors = require('cors');
const multer = require('multer');
const compression = require('compression');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { PDFDocument } = require('pdf-lib');

const app = express();
const port = process.env.PORT || 3001;

// Security middleware
app.use(helmet({
  contentSecurityPolicy: false, // Disable for PDF processing
  crossOriginEmbedderPolicy: false
}));

// Compression middleware
app.use(compression({
  level: 6,
  threshold: 1024,
  filter: (req, res) => {
    if (req.headers['x-no-compression']) {
      return false;
    }
    return compression.filter(req, res);
  }
}));

// CORS configuration
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: [
    'X-CSRF-Token',
    'X-Requested-With',
    'Accept',
    'Accept-Version',
    'Content-Length',
    'Content-MD5',
    'Content-Type',
    'Date',
    'X-Api-Version',
    'X-Device-Type',
    'X-Client-Memory',
    'X-Total-Size',
    'X-Priority'
  ]
}));

// Rate limiting
const limiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 100, // limit each IP to 100 requests per windowMs
  message: {
    error: 'Too many requests from this IP, please try again later.',
    retryAfter: 60
  },
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    res.status(429).json({
      error: 'Too many requests',
      message: 'Please try again later',
      retryAfter: 60
    });
  }
});

app.use('/api/', limiter);

// File upload configuration
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 200 * 1024 * 1024, // 200MB per file
    files: 20, // Maximum 20 files
    fieldSize: 1024 * 1024 // 1MB field size
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype !== 'application/pdf') {
      return cb(new Error('Only PDF files are allowed'), false);
    }
    cb(null, true);
  }
});

// Error handling middleware
app.use((error, req, res, next) => {
  console.error('Server error:', error);
  
  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'File too large. Maximum 200MB per file.' });
    }
    if (error.code === 'LIMIT_FILE_COUNT') {
      return res.status(400).json({ error: 'Too many files. Maximum 20 files allowed.' });
    }
    if (error.code === 'LIMIT_FIELD_COUNT') {
      return res.status(400).json({ error: 'Too many fields.' });
    }
  }
  
  if (error.message === 'Only PDF files are allowed') {
    return res.status(400).json({ error: 'Only PDF files are allowed' });
  }
  
  res.status(500).json({ error: 'Internal server error' });
});

// Health check endpoint
app.get('/api/healthcheck', (req, res) => {
  const health = {
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    environment: process.env.NODE_ENV || 'development'
  };
  
  res.json(health);
});

// PDF merge endpoint with enhanced error handling
app.post('/api/merge', upload.array('files'), async (req, res) => {
  const startTime = Date.now();
  
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No files provided' });
    }

    if (req.files.length < 2) {
      return res.status(400).json({ error: 'At least 2 files are required' });
    }

    if (req.files.length > 20) {
      return res.status(400).json({ error: 'Maximum 20 files allowed' });
    }

    // Calculate total size
    const totalSize = req.files.reduce((sum, file) => sum + file.size, 0);
    if (totalSize > 200 * 1024 * 1024) {
      return res.status(400).json({ error: 'Total file size exceeds 200MB limit' });
    }

    console.log(`[PDF Merge] Processing ${req.files.length} files, total size: ${(totalSize / 1024 / 1024).toFixed(2)}MB`);

    // Create merged PDF
    const mergedPdf = await PDFDocument.create();
    let totalPages = 0;
    
    // Process files with progress tracking
    for (let i = 0; i < req.files.length; i++) {
      const file = req.files[i];
      
      try {
        console.log(`[PDF Merge] Processing file ${i + 1}/${req.files.length}: ${file.originalname}`);
        
        const pdfDoc = await PDFDocument.load(file.buffer, {
          updateMetadata: false,
          ignoreEncryption: true
        });
        
        const pageCount = pdfDoc.getPageCount();
        totalPages += pageCount;
        
        const copiedPages = await mergedPdf.copyPages(pdfDoc, pdfDoc.getPageIndices());
        copiedPages.forEach((page) => mergedPdf.addPage(page));
        
        console.log(`[PDF Merge] Added ${pageCount} pages from ${file.originalname}`);
        
      } catch (error) {
        console.error(`[PDF Merge] Error processing file ${file.originalname}:`, error);
        return res.status(400).json({ 
          error: `Failed to process file ${file.originalname}: ${error.message}` 
        });
      }
    }

    console.log(`[PDF Merge] Saving merged PDF with ${totalPages} pages`);
    
    // Save the merged PDF
    const mergedPdfBuffer = await mergedPdf.save({
      useObjectStreams: true,
      addDefaultPage: false
    });
    
    const processingTime = Date.now() - startTime;
    const compressionRatio = mergedPdfBuffer.length / totalSize;
    
    console.log(`[PDF Merge] Completed in ${processingTime}ms, compression ratio: ${compressionRatio.toFixed(2)}`);
    
    // Set response headers
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename=merged.pdf');
    res.setHeader('Content-Length', mergedPdfBuffer.length);
    res.setHeader('X-Total-Pages', totalPages);
    res.setHeader('X-Total-Size', totalSize);
    res.setHeader('X-Processing-Time', processingTime);
    res.setHeader('X-Compression-Ratio', compressionRatio.toFixed(2));
    res.setHeader('Cache-Control', 'no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    
    // Send the merged PDF
    res.send(Buffer.from(mergedPdfBuffer));
    
  } catch (error) {
    console.error('[PDF Merge] Error:', error);
    const processingTime = Date.now() - startTime;
    
    res.status(500).json({ 
      error: 'Failed to merge PDFs',
      details: error.message,
      processingTime
    });
  }
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

// Global error handler
app.use((error, req, res, next) => {
  console.error('Unhandled error:', error);
  res.status(500).json({ error: 'Internal server error' });
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down gracefully');
  process.exit(0);
});

// Memory monitoring
setInterval(() => {
  const memUsage = process.memoryUsage();
  if (memUsage.heapUsed > 1024 * 1024 * 1024) { // 1GB
    console.warn('High memory usage:', {
      heapUsed: `${(memUsage.heapUsed / 1024 / 1024).toFixed(2)}MB`,
      heapTotal: `${(memUsage.heapTotal / 1024 / 1024).toFixed(2)}MB`,
      external: `${(memUsage.external / 1024 / 1024).toFixed(2)}MB`
    });
  }
}, 30000); // Check every 30 seconds

app.listen(port, () => {
  console.log(`Backend server running on port ${port}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`Memory usage: ${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2)}MB`);
}); 
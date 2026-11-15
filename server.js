const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');

const app = express();
const PORT = process.env.PORT || 3003;
const HTML_DIR = path.join(__dirname, 'html');
const FILES_DIR = path.join(HTML_DIR, 'files');
const CONFIG_FILE = path.join(__dirname, 'config.json');

// Ensure directories exist
if (!fs.existsSync(HTML_DIR)) {
  fs.mkdirSync(HTML_DIR, { recursive: true });
}
if (!fs.existsSync(FILES_DIR)) {
  fs.mkdirSync(FILES_DIR, { recursive: true });
}

// Config management (file-based database)
function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    }
  } catch (err) {
    console.error('Error loading config:', err);
  }
  return { version: '1.0', created: new Date().toISOString() };
}

function saveConfig(config) {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
  } catch (err) {
    console.error('Error saving config:', err);
  }
}

// Middleware
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ limit: '100mb', extended: true }));

// Multer configuration
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      let targetDir = FILES_DIR;

      if (req.body && req.body.dir) {
        const dirParam = req.body.dir;
        // Validate: prevent directory traversal
        if (dirParam && !dirParam.includes('..')) {
          targetDir = path.join(FILES_DIR, dirParam);
        }
      }

      if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
      }
      cb(null, targetDir);
    },
    filename: (req, file, cb) => {
      cb(null, file.originalname);
    }
  }),
  limits: { fileSize: 500 * 1024 * 1024 } // 500MB limit
});

// Serve static files from html directory
app.use(express.static(HTML_DIR));

// Helper: recursively list files with structure
function listFilesRecursive(dir, baseDir, prefix = '') {
  const items = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    entries.sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return b.isDirectory() ? 1 : -1;
      return a.name.localeCompare(b.name);
    });

    entries.forEach(entry => {
      if (entry.name.startsWith('.')) return;
      const fullPath = path.join(dir, entry.name);
      const relativePath = path.relative(baseDir, fullPath);

      if (entry.isDirectory()) {
        items.push({
          name: entry.name,
          type: 'directory',
          path: relativePath,
          children: listFilesRecursive(fullPath, baseDir, prefix + '  ')
        });
      } else {
        items.push({
          name: entry.name,
          type: 'file',
          path: relativePath,
          downloadPath: `/download/files/${relativePath}`
        });
      }
    });
  } catch (err) {
    console.error('Error listing directory:', dir, err);
  }
  return items;
}

// API endpoint to list files
app.get('/api/files', (req, res) => {
  try {
    const items = listFilesRecursive(FILES_DIR, FILES_DIR);
    res.json({ items });
  } catch (err) {
    console.error('Error listing files:', err);
    res.status(500).json({ error: 'Failed to list files' });
  }
});

// API endpoint to upload file
app.post('/api/upload', upload.single('file'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }
    res.json({
      success: true,
      message: 'File uploaded successfully',
      filename: req.file.originalname,
      dir: req.body.dir || 'root'
    });
  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({ error: 'Upload failed: ' + err.message });
  }
});

// API endpoint to create directory
app.post('/api/mkdir', express.json(), (req, res) => {
  try {
    const { dirName, parentPath } = req.body;
    if (!dirName || dirName.includes('..')) {
      return res.status(400).json({ error: 'Invalid directory name' });
    }

    let newDir;
    if (parentPath && !parentPath.includes('..')) {
      newDir = path.join(FILES_DIR, parentPath, dirName);
    } else {
      newDir = path.join(FILES_DIR, dirName);
    }

    if (fs.existsSync(newDir)) {
      return res.status(400).json({ error: 'Directory already exists' });
    }

    fs.mkdirSync(newDir, { recursive: true });

    const config = loadConfig();
    if (!config.directories) config.directories = [];
    config.directories.push({
      path: path.relative(FILES_DIR, newDir),
      created: new Date().toISOString()
    });
    saveConfig(config);

    res.json({ success: true, message: 'Directory created' });
  } catch (err) {
    console.error('Mkdir error:', err);
    res.status(500).json({ error: 'Failed to create directory: ' + err.message });
  }
});

// API endpoint to delete file or directory
app.post('/api/delete', express.json(), (req, res) => {
  try {
    const { filePath } = req.body;
    if (!filePath || filePath.includes('..')) {
      return res.status(400).json({ error: 'Invalid path' });
    }

    const fullPath = path.join(FILES_DIR, filePath);
    if (!fullPath.startsWith(FILES_DIR)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    if (!fs.existsSync(fullPath)) {
      return res.status(404).json({ error: 'File or directory not found' });
    }

    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      fs.rmSync(fullPath, { recursive: true, force: true });
    } else {
      fs.unlinkSync(fullPath);
    }

    res.json({ success: true, message: 'Deleted successfully' });
  } catch (err) {
    console.error('Delete error:', err);
    res.status(500).json({ error: 'Delete failed: ' + err.message });
  }
});

// API endpoint to get config
app.get('/api/config', (req, res) => {
  try {
    const config = loadConfig();
    res.json(config);
  } catch (err) {
    console.error('Config error:', err);
    res.status(500).json({ error: 'Failed to load config' });
  }
});

// File download endpoint
app.get('/download/*', (req, res) => {
  try {
    const filePath = req.params[0];
    const fullPath = path.join(FILES_DIR, filePath);

    // Security: prevent directory traversal
    if (!fullPath.startsWith(FILES_DIR)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    if (!fs.existsSync(fullPath)) {
      return res.status(404).json({ error: 'File not found' });
    }

    res.download(fullPath);
  } catch (err) {
    console.error('Download error:', err);
    res.status(500).json({ error: 'Download failed' });
  }
});

// Main page - serve index.html if it exists, otherwise show file browser
app.get('/', (req, res) => {
  const indexPath = path.join(HTML_DIR, 'index.html');
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.sendFile(path.join(__dirname, 'default-index.html'));
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`FTP Webpage running on http://0.0.0.0:${PORT}`);
  console.log(`HTML directory: ${HTML_DIR}`);
  console.log(`Files directory: ${FILES_DIR}`);
});

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const frontendComponent = fs.readFileSync(path.join(repoRoot, 'frontend', 'components', 'AdminNotifications.jsx'), 'utf8');
const frontendApi = fs.readFileSync(path.join(repoRoot, 'frontend', 'lib', 'api.js'), 'utf8');
const adminRoutes = fs.readFileSync(path.join(__dirname, 'src', 'routes', 'adminRoutes.js'), 'utf8');
const server = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
const notificationService = fs.readFileSync(path.join(__dirname, 'src', 'services', 'notificationService.js'), 'utf8');

assert.match(frontendComponent, /type=["']file["']/, 'Admin notification UI must render a real file input.');
assert.doesNotMatch(frontendComponent, /msgForm\.subject\.target\.files/, 'Upload handler must not read files from the subject string.');
assert.doesNotMatch(frontendComponent, /const handleFileUpload\s*=.*handleFileUpload\(file\)/s, 'Component upload handler must not recursively shadow the API upload helper.');
assert.match(frontendComponent, /fileUrl/, 'Uploaded file URL must be kept in message state and sent with the notification.');

assert.match(frontendApi, /delete headers\[['"]Content-Type['"]\]/, 'FormData uploads must let the browser set multipart Content-Type with boundary.');

assert.match(adminRoutes, /multer/, 'Admin notification upload route must use multipart middleware.');
assert.match(adminRoutes, /upload\.single\(['"]file['"]\)/, 'Upload route must parse the form field named file.');
assert.match(server, /app\.use\(['"]\/uploads['"]/, 'Uploaded files must be served from /uploads.');

assert.match(notificationService, /fileUrl/, 'Notification service must include the uploaded file URL in outgoing messages.');

console.log('notification upload static regression checks passed');

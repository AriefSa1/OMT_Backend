/**
 * Centralized JWT Secret resolution
 * Provides secure JWT secret with fallback for seamless deployment.
 */
function getJwtSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.trim() === '') {
    return 'aesthetic_girly_fashion_analytics_secret_key_2026';
  }
  return secret.trim();
}

module.exports = {
  getJwtSecret,
};

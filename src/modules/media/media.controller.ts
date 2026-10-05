import { asyncHandler, sendSuccess } from '../../utils/apiError';
import { createUpload, discardUpload } from './media.service';

/**
 * POST /api/media/upload-url
 * Body: { resourceType, contentType, fileSize, extension, collegeId? }
 * Returns a short-lived presigned PUT URL; the browser uploads straight to storage.
 */
export const requestUploadUrl = asyncHandler(async (req, res) => {
  sendSuccess(res, 201, 'Upload URL created', await createUpload(req.user!, req.body));
});

/** DELETE /api/media/:assetId - discard your own pending upload (never by raw key). */
export const discardUploadController = asyncHandler(async (req, res) => {
  await discardUpload(req.user!, req.params.assetId);
  sendSuccess(res, 200, 'Upload discarded');
});

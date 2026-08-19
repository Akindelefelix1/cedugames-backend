# Cloudinary media setup

All question and answer attachments (images, audio, video, and PDF documents) are uploaded by the backend to Cloudinary. The Admin app continues sending multipart form data to the API, and both frontend apps render the HTTPS URL returned by Cloudinary. Never put the API secret in either frontend.

## 1. Get the Cloudinary values

1. Create or sign in to your account at https://console.cloudinary.com/.
2. Select the correct **Product Environment**. Copy **Cloud name** from the Dashboard.
3. Open **Settings** (gear icon) and then **API Keys**.
4. Copy the **API Key**.
5. Reveal and copy the **API Secret**. Cloudinary may ask you to confirm your password.
6. Choose an application folder name. This is not supplied by Cloudinary; use `cedugames` unless you intentionally want another root folder.

Map the values as follows:

```env
CLOUDINARY_CLOUD_NAME=the_cloud_name_from_your_dashboard
CLOUDINARY_API_KEY=the_key_from_settings_api_keys
CLOUDINARY_API_SECRET=the_revealed_secret_from_settings_api_keys
CLOUDINARY_FOLDER=cedugames
```

The secret is server-only. Keep `.env` ignored by Git, do not prefix these names with `REACT_APP_` or `VITE_`, and do not paste the secret into Admin or Users source code.

## 2. Configure locally

Put the four variables above in `Cedugames_BE/.env`, then restart the backend:

```powershell
cd C:\Users\akind\Desktop\Cedugames_BE
npm run server
```

No Cloudinary variables are required in `Cedugames_Admin` or `Cedugames_Users`. Those apps only need their existing backend base URL.

## 3. Configure Render

In the Render dashboard, open the backend Web Service, select **Environment**, add the same four variables, save, and redeploy. Add them only to the backend service. Do not add quotes or trailing spaces.

## 4. Verify end to end

1. Sign in to the Admin app and create a question with an image, audio, video, or PDF attachment.
2. In the browser Network panel, confirm `POST /admin/questions` returns `201`.
3. In Cloudinary, open **Assets** and find the file under `cedugames/questions`.
4. Open that question in Admin and play the same level in Users; both should load an `https://res.cloudinary.com/...` URL.
5. Replace or delete the attachment and confirm the prior Cloudinary asset is removed. CDN invalidation can take a short time.

Existing `/uploads/questions/...` database values remain readable through the legacy static route. New uploads use Cloudinary. If the Render filesystem has already lost an older local file, it must be uploaded again from Admin.

## Limits and accepted files

Each request accepts at most five files and each file can be at most 20 MB. Supported formats are JPEG, PNG, GIF, WebP, MP3, WAV, OGG, MP4, WebM, and PDF. The backend authenticates the admin, validates MIME types, uploads with automatic Cloudinary resource-type detection, stores only secure URLs in PostgreSQL, and cleans up Cloudinary assets after replacement, deletion, or a failed database transaction.

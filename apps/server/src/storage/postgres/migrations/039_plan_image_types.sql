ALTER TABLE plan_images
	DROP CONSTRAINT plan_images_mime_type_check,
	ADD CONSTRAINT plan_images_mime_type_check CHECK (
		mime_type IN (
			'image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif', 'image/bmp', 'image/x-icon'
		)
	);

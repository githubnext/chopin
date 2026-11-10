ALTER TABLE plan_images
	DROP CONSTRAINT plan_images_check,
	ADD CONSTRAINT plan_images_size_check CHECK (size = octet_length(bytes));

/**
 * The Ubuntu packages every agent image unpacks beside Node: git and the libraries its HTTPS remote
 * needs that the NVX release's Ubuntu layer (26.04, `amd64`) doesn't hold. Each is pinned by its
 * archive path and SHA-256, downloaded by the host and checked before a guest unpacks it, so an
 * image is the same wherever it is built. Regenerated with the layer: the packages its manifest
 * lists are left out, and the rest of git's runtime dependencies come from the release's pockets.
 */
export type GuestPackage = { name: string; version: string; path: string; sha256: string };

export const GUEST_PACKAGES: readonly GuestPackage[] = [
	{
		name: "git",
		version: "1:2.53.0-1ubuntu1.1",
		path: "pool/main/g/git/git_2.53.0-1ubuntu1.1_amd64.deb",
		sha256: "5d3bbbb8e5bee7ddeb1d023b9a9d2063633e30c3ec404fd1d75136d9c6e48603",
	},
	{
		name: "libcurl3t64-gnutls",
		version: "8.18.0-1ubuntu2.8",
		path: "pool/main/c/curl/libcurl3t64-gnutls_8.18.0-1ubuntu2.8_amd64.deb",
		sha256: "8db913e1fa5a694ca6ba7b828bd18c5204e6853ac07fe7ed9c6e1f94e3444d8e",
	},
	{
		name: "libbrotli1",
		version: "1.2.0-3ubuntu0.1",
		path: "pool/main/b/brotli/libbrotli1_1.2.0-3ubuntu0.1_amd64.deb",
		sha256: "bedeef1cf3268f90338c411cdb0a45b224d0660fd2240f310f380316c8244606",
	},
	{
		name: "libgnutls30t64",
		version: "3.8.12-2ubuntu1.1",
		path: "pool/main/g/gnutls28/libgnutls30t64_3.8.12-2ubuntu1.1_amd64.deb",
		sha256: "b08d4e2842cd53dbe1565a46bd11d6f7ecb36bc08b236802ae4da744cae9f691",
	},
	{
		name: "libgssapi-krb5-2",
		version: "1.22.1-2ubuntu4.1",
		path: "pool/main/k/krb5/libgssapi-krb5-2_1.22.1-2ubuntu4.1_amd64.deb",
		sha256: "d156dd940bff6dec8b6880cd0da4d515398d03d7b2e8b3163a935e701f80aa27",
	},
	{
		name: "libk5crypto3",
		version: "1.22.1-2ubuntu4.1",
		path: "pool/main/k/krb5/libk5crypto3_1.22.1-2ubuntu4.1_amd64.deb",
		sha256: "8e99ef104a6bf49bea708747fdf4c28eb4fcebd6dba9e55ecfa919211eb5ab75",
	},
	{
		name: "libkeyutils1",
		version: "1.6.3-6ubuntu3",
		path: "pool/main/k/keyutils/libkeyutils1_1.6.3-6ubuntu3_amd64.deb",
		sha256: "ea7d3cc642ffe2459c35a85c894f80e92499b9eba13bdcb225e0aa751c0970be",
	},
	{
		name: "libkrb5-3",
		version: "1.22.1-2ubuntu4.1",
		path: "pool/main/k/krb5/libkrb5-3_1.22.1-2ubuntu4.1_amd64.deb",
		sha256: "54612a2019863c44d80218f40d40670c3684108f4b2a760aae644ab68457e239",
	},
	{
		name: "libkrb5support0",
		version: "1.22.1-2ubuntu4.1",
		path: "pool/main/k/krb5/libkrb5support0_1.22.1-2ubuntu4.1_amd64.deb",
		sha256: "127d735efece139dfb7109ac3709da7eb8923bef090c20a10dbaf4c4fa45001d",
	},
	{
		name: "libldap2",
		version: "2.6.10+dfsg-1ubuntu5",
		path: "pool/main/o/openldap/libldap2_2.6.10+dfsg-1ubuntu5_amd64.deb",
		sha256: "8d3a361e8655a0ff4a390243059949fa6f22d42d0e266f58b57c124eb21d2993",
	},
	{
		name: "libnghttp2-14",
		version: "1.68.0-2ubuntu0.2",
		path: "pool/main/n/nghttp2/libnghttp2-14_1.68.0-2ubuntu0.2_amd64.deb",
		sha256: "9c92ca4435998b7981cf81f957177b71079563b022c282a4b8b7829113a5d08e",
	},
	{
		name: "libpsl5t64",
		version: "0.21.2-1.1build2",
		path: "pool/main/libp/libpsl/libpsl5t64_0.21.2-1.1build2_amd64.deb",
		sha256: "1ae62705714f660ecdfd70273fce5b226b6cb7b9fe53776531799093edc99774",
	},
	{
		name: "librtmp1",
		version: "2.4+20151223.gitfa8646d.1-3",
		path: "pool/main/r/rtmpdump/librtmp1_2.4+20151223.gitfa8646d.1-3_amd64.deb",
		sha256: "77cbd0ddf7e7487079ec300ff7751322de5e7d67f0f46749591b78ff1442cbe8",
	},
	{
		name: "libsasl2-2",
		version: "2.1.28+dfsg1-9ubuntu3",
		path: "pool/main/c/cyrus-sasl2/libsasl2-2_2.1.28+dfsg1-9ubuntu3_amd64.deb",
		sha256: "11b9b2ce6702d86dd3dea60e08bd15255d7fd9545431a9e555eec47770404de0",
	},
	{
		name: "libsasl2-modules-db",
		version: "2.1.28+dfsg1-9ubuntu3",
		path: "pool/main/c/cyrus-sasl2/libsasl2-modules-db_2.1.28+dfsg1-9ubuntu3_amd64.deb",
		sha256: "1de7b83844537091315210afb466ff2cd022874db5a6a785ce06b41bd3507eb3",
	},
	{
		name: "libssh2-1t64",
		version: "1.11.1-1ubuntu0.26.04.4",
		path: "pool/main/libs/libssh2/libssh2-1t64_1.11.1-1ubuntu0.26.04.4_amd64.deb",
		sha256: "bb3e334dc885d124d38cd4350f1cb4606c03ce58e9f53dc51a84c2c8d11c84e1",
	},
	{
		name: "libnettle8t64",
		version: "3.10.2-1",
		path: "pool/main/n/nettle/libnettle8t64_3.10.2-1_amd64.deb",
		sha256: "83a2a924c11759a2ed6e6f98f456d28e1b026974ce9e6e7ef12c9ac43b2d543e",
	},
	{
		name: "libhogweed6t64",
		version: "3.10.2-1",
		path: "pool/main/n/nettle/libhogweed6t64_3.10.2-1_amd64.deb",
		sha256: "1c8c808ab24ff3018ac886e3f311edee0f2d4d97d12d3908be52343e89807046",
	},
	{
		name: "libp11-kit0",
		version: "0.26.2-2",
		path: "pool/main/p/p11-kit/libp11-kit0_0.26.2-2_amd64.deb",
		sha256: "e70d3422e24b267293215134458f340944bf10e92b27147594c69a7dd2823089",
	},
	{
		name: "libtasn1-6",
		version: "4.21.0-2",
		path: "pool/main/libt/libtasn1-6/libtasn1-6_4.21.0-2_amd64.deb",
		sha256: "59c74951324ead0ff77ab945d561feb1b21bc189b793600b8e2b7cf4d39b1ee5",
	},
	{
		name: "libffi8",
		version: "3.5.2-4",
		path: "pool/main/libf/libffi/libffi8_3.5.2-4_amd64.deb",
		sha256: "4a7423124bbd459c0aa38b7389ec7802fa6899654767a95fc27de70967fedd48",
	},
	{
		name: "libexpat1",
		version: "2.7.4-1ubuntu0.3",
		path: "pool/main/e/expat/libexpat1_2.7.4-1ubuntu0.3_amd64.deb",
		sha256: "9204c4d870591e984903b3ebb78c5b1bcd684f3722acc014d5b59df4cf78b55e",
	},
];

/**
 * What an image's build unpacks in its own guest, and nowhere else: erofs-utils, which unpacks the
 * NVX release's Ubuntu layer and makes the image's layer, with the libraries it needs beyond the
 * layer's.
 */
export const BUILD_PACKAGES: readonly GuestPackage[] = [
	{
		name: "erofs-utils",
		version: "1.9.1-1",
		path: "pool/universe/e/erofs-utils/erofs-utils_1.9.1-1_amd64.deb",
		sha256: "e06b009c4e53e6cbb848ac98dd2d1862eaa3daa1a63e4e860e59f482acf616b5",
	},
	{
		name: "libcurl4t64",
		version: "8.18.0-1ubuntu2.8",
		path: "pool/main/c/curl/libcurl4t64_8.18.0-1ubuntu2.8_amd64.deb",
		sha256: "7c0b37592f83a629cc22f0c98effa176da9edbd6d77b3f38184a9d0ddc5e0266",
	},
	{
		name: "libbrotli1",
		version: "1.2.0-3ubuntu0.1",
		path: "pool/main/b/brotli/libbrotli1_1.2.0-3ubuntu0.1_amd64.deb",
		sha256: "bedeef1cf3268f90338c411cdb0a45b224d0660fd2240f310f380316c8244606",
	},
	{
		name: "libgssapi-krb5-2",
		version: "1.22.1-2ubuntu4.1",
		path: "pool/main/k/krb5/libgssapi-krb5-2_1.22.1-2ubuntu4.1_amd64.deb",
		sha256: "d156dd940bff6dec8b6880cd0da4d515398d03d7b2e8b3163a935e701f80aa27",
	},
	{
		name: "libkrb5-3",
		version: "1.22.1-2ubuntu4.1",
		path: "pool/main/k/krb5/libkrb5-3_1.22.1-2ubuntu4.1_amd64.deb",
		sha256: "54612a2019863c44d80218f40d40670c3684108f4b2a760aae644ab68457e239",
	},
	{
		name: "libkrb5support0",
		version: "1.22.1-2ubuntu4.1",
		path: "pool/main/k/krb5/libkrb5support0_1.22.1-2ubuntu4.1_amd64.deb",
		sha256: "127d735efece139dfb7109ac3709da7eb8923bef090c20a10dbaf4c4fa45001d",
	},
	{
		name: "libk5crypto3",
		version: "1.22.1-2ubuntu4.1",
		path: "pool/main/k/krb5/libk5crypto3_1.22.1-2ubuntu4.1_amd64.deb",
		sha256: "8e99ef104a6bf49bea708747fdf4c28eb4fcebd6dba9e55ecfa919211eb5ab75",
	},
	{
		name: "libkeyutils1",
		version: "1.6.3-6ubuntu3",
		path: "pool/main/k/keyutils/libkeyutils1_1.6.3-6ubuntu3_amd64.deb",
		sha256: "ea7d3cc642ffe2459c35a85c894f80e92499b9eba13bdcb225e0aa751c0970be",
	},
	{
		name: "libldap2",
		version: "2.6.10+dfsg-1ubuntu5",
		path: "pool/main/o/openldap/libldap2_2.6.10+dfsg-1ubuntu5_amd64.deb",
		sha256: "8d3a361e8655a0ff4a390243059949fa6f22d42d0e266f58b57c124eb21d2993",
	},
	{
		name: "libsasl2-2",
		version: "2.1.28+dfsg1-9ubuntu3",
		path: "pool/main/c/cyrus-sasl2/libsasl2-2_2.1.28+dfsg1-9ubuntu3_amd64.deb",
		sha256: "11b9b2ce6702d86dd3dea60e08bd15255d7fd9545431a9e555eec47770404de0",
	},
	{
		name: "libsasl2-modules-db",
		version: "2.1.28+dfsg1-9ubuntu3",
		path: "pool/main/c/cyrus-sasl2/libsasl2-modules-db_2.1.28+dfsg1-9ubuntu3_amd64.deb",
		sha256: "1de7b83844537091315210afb466ff2cd022874db5a6a785ce06b41bd3507eb3",
	},
	{
		name: "libldap-common",
		version: "2.6.10+dfsg-1ubuntu5",
		path: "pool/main/o/openldap/libldap-common_2.6.10+dfsg-1ubuntu5_all.deb",
		sha256: "919b209f5040c1dca1d9c3912521e4bc476028c2e16905ab09347004a599a722",
	},
	{
		name: "libnghttp2-14",
		version: "1.68.0-2ubuntu0.2",
		path: "pool/main/n/nghttp2/libnghttp2-14_1.68.0-2ubuntu0.2_amd64.deb",
		sha256: "9c92ca4435998b7981cf81f957177b71079563b022c282a4b8b7829113a5d08e",
	},
	{
		name: "libpsl5t64",
		version: "0.21.2-1.1build2",
		path: "pool/main/libp/libpsl/libpsl5t64_0.21.2-1.1build2_amd64.deb",
		sha256: "1ae62705714f660ecdfd70273fce5b226b6cb7b9fe53776531799093edc99774",
	},
	{
		name: "librtmp1",
		version: "2.4+20151223.gitfa8646d.1-3",
		path: "pool/main/r/rtmpdump/librtmp1_2.4+20151223.gitfa8646d.1-3_amd64.deb",
		sha256: "77cbd0ddf7e7487079ec300ff7751322de5e7d67f0f46749591b78ff1442cbe8",
	},
	{
		name: "libgnutls30t64",
		version: "3.8.12-2ubuntu1.1",
		path: "pool/main/g/gnutls28/libgnutls30t64_3.8.12-2ubuntu1.1_amd64.deb",
		sha256: "b08d4e2842cd53dbe1565a46bd11d6f7ecb36bc08b236802ae4da744cae9f691",
	},
	{
		name: "libhogweed6t64",
		version: "3.10.2-1",
		path: "pool/main/n/nettle/libhogweed6t64_3.10.2-1_amd64.deb",
		sha256: "1c8c808ab24ff3018ac886e3f311edee0f2d4d97d12d3908be52343e89807046",
	},
	{
		name: "libnettle8t64",
		version: "3.10.2-1",
		path: "pool/main/n/nettle/libnettle8t64_3.10.2-1_amd64.deb",
		sha256: "83a2a924c11759a2ed6e6f98f456d28e1b026974ce9e6e7ef12c9ac43b2d543e",
	},
	{
		name: "libp11-kit0",
		version: "0.26.2-2",
		path: "pool/main/p/p11-kit/libp11-kit0_0.26.2-2_amd64.deb",
		sha256: "e70d3422e24b267293215134458f340944bf10e92b27147594c69a7dd2823089",
	},
	{
		name: "libffi8",
		version: "3.5.2-4",
		path: "pool/main/libf/libffi/libffi8_3.5.2-4_amd64.deb",
		sha256: "4a7423124bbd459c0aa38b7389ec7802fa6899654767a95fc27de70967fedd48",
	},
	{
		name: "libtasn1-6",
		version: "4.21.0-2",
		path: "pool/main/libt/libtasn1-6/libtasn1-6_4.21.0-2_amd64.deb",
		sha256: "59c74951324ead0ff77ab945d561feb1b21bc189b793600b8e2b7cf4d39b1ee5",
	},
	{
		name: "libssh2-1t64",
		version: "1.11.1-1ubuntu0.26.04.4",
		path: "pool/main/libs/libssh2/libssh2-1t64_1.11.1-1ubuntu0.26.04.4_amd64.deb",
		sha256: "bb3e334dc885d124d38cd4350f1cb4606c03ce58e9f53dc51a84c2c8d11c84e1",
	},
	{
		name: "libdeflate0",
		version: "1.23-2ubuntu1",
		path: "pool/main/libd/libdeflate/libdeflate0_1.23-2ubuntu1_amd64.deb",
		sha256: "40ee517cffd3730405be6ae30826533bec0ddf8773bb7ac2cccd22a57acafc25",
	},
	{
		name: "libjson-c5",
		version: "0.18+ds-3",
		path: "pool/main/j/json-c/libjson-c5_0.18+ds-3_amd64.deb",
		sha256: "a19fa7f6504920f13e5fd291cf3c626d7201a48a0d80fde7cdac34f95306d352",
	},
	{
		name: "libxml2-16",
		version: "2.15.2+dfsg-0.1ubuntu0.3",
		path: "pool/main/libx/libxml2/libxml2-16_2.15.2+dfsg-0.1ubuntu0.3_amd64.deb",
		sha256: "e82ce35fd61483c1febf83232e76e54a296a6a78391983a24a904ff640b75c09",
	},
];

/** Where the packages are downloaded from. */
export const UBUNTU_ARCHIVE = "https://archive.ubuntu.com/ubuntu/";

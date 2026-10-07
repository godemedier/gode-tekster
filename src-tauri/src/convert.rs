//! HEIC (iPhone) og TIFF (scanner, billedbureauer) kan WebView2 ikke vise. De laves om til JPEG
//! med Windows' egen billedmotor (WIC), når de sættes ind, og originalen røres ikke (2/10).
//! Kameraets retning (System.Photo.Orientation) lægges ind i pixlerne. Metadata som GPS og kamera
//! kommer ikke med i kopien.
//!
//! HEIC kræver Microsofts »HEIF-billedudvidelser« og »HEVC-videoudvidelser«. Mangler de,
//! får brugeren en besked, der siger hvad der skal installeres.

/// Formater, der laves om til JPEG. Resten vises som de er.
pub const CONVERT_EXT: &[&str] = &["heic", "heif", "tif", "tiff"];

#[cfg(windows)]
pub fn to_jpeg(bytes: &[u8], ext: &str) -> Result<Vec<u8>, String> {
    // Egen tråd: COM initialiseres rent her, uanset hvad Tauris tråde har gang i.
    let data = bytes.to_vec();
    let result = std::thread::spawn(move || wic::to_jpeg(&data))
        .join()
        .map_err(|_| {
            t!(
                "Billedet kunne ikke laves om til JPEG.",
                "The image could not be converted to JPEG."
            )
            .to_owned()
        })?;
    result.map_err(|e| {
        // WINCODEC_ERR_COMPONENTNOTFOUND: ingen dekoder til formatet.
        if e.code().0 as u32 == 0x8898_2F50 && ext.starts_with("hei") {
            t!(
                "Windows kan ikke læse HEIC-billeder. Installér »HEIF-billedudvidelser« og »HEVC-videoudvidelser« fra Microsoft Store.",
                "Windows cannot read HEIC images. Install \"HEIF Image Extensions\" and \"HEVC Video Extensions\" from the Microsoft Store."
            )
            .to_owned()
        } else {
            t!(
                format!("Billedet kunne ikke laves om til JPEG: {}", e.message()),
                format!("The image could not be converted to JPEG: {}", e.message())
            )
        }
    })
}

#[cfg(not(windows))]
pub fn to_jpeg(_bytes: &[u8], _ext: &str) -> Result<Vec<u8>, String> {
    Err(t!(
        "HEIC og TIFF kan kun laves om på Windows.",
        "HEIC and TIFF can only be converted on Windows."
    )
    .to_owned())
}

/// EXIF-retningen som WIC-transformation. 1 og ukendte værdier: ingenting.
#[cfg(windows)]
fn transform(
    orientation: u16,
) -> Option<windows::Win32::Graphics::Imaging::WICBitmapTransformOptions> {
    use windows::Win32::Graphics::Imaging::*;
    Some(match orientation {
        2 => WICBitmapTransformFlipHorizontal,
        3 => WICBitmapTransformRotate180,
        4 => WICBitmapTransformFlipVertical,
        5 => WICBitmapTransformOptions(
            WICBitmapTransformRotate90.0 | WICBitmapTransformFlipHorizontal.0,
        ),
        6 => WICBitmapTransformRotate90,
        7 => WICBitmapTransformOptions(
            WICBitmapTransformRotate270.0 | WICBitmapTransformFlipHorizontal.0,
        ),
        8 => WICBitmapTransformRotate270,
        _ => return None,
    })
}

#[cfg(windows)]
mod wic {
    use windows::core::{w, Error, Interface, Result};
    use windows::Win32::Foundation::{E_FAIL, HGLOBAL};
    use windows::Win32::Graphics::Imaging::*;
    use windows::Win32::System::Com::StructuredStorage::{
        CreateStreamOnHGlobal, PropVariantClear, PROPVARIANT,
    };
    use windows::Win32::System::Com::*;
    use windows::Win32::System::Variant::VT_UI2;

    struct Com;
    impl Drop for Com {
        fn drop(&mut self) {
            unsafe { CoUninitialize() }
        }
    }

    pub fn to_jpeg(bytes: &[u8]) -> Result<Vec<u8>> {
        unsafe {
            CoInitializeEx(None, COINIT_MULTITHREADED).ok()?;
            let _com = Com;
            let factory: IWICImagingFactory =
                CoCreateInstance(&CLSID_WICImagingFactory, None, CLSCTX_INPROC_SERVER)?;

            let input = factory.CreateStream()?;
            input.InitializeFromMemory(bytes)?;
            let decoder = factory.CreateDecoderFromStream(
                &input,
                std::ptr::null(),
                WICDecodeMetadataCacheOnDemand,
            )?;
            let frame = decoder.GetFrame(0)?;

            // JPEG kender ikke gennemsigtighed eller CMYK: alt bliver 24 bit BGR.
            let converter = factory.CreateFormatConverter()?;
            converter.Initialize(
                &frame,
                &GUID_WICPixelFormat24bppBGR,
                WICBitmapDitherTypeNone,
                None,
                0.0,
                WICBitmapPaletteTypeCustom,
            )?;
            let source: IWICBitmapSource = match super::transform(orientation(&frame)) {
                Some(t) => {
                    let rotator = factory.CreateBitmapFlipRotator()?;
                    rotator.Initialize(&converter, t)?;
                    rotator.cast()?
                }
                None => converter.cast()?,
            };
            let (mut width, mut height) = (0, 0);
            source.GetSize(&mut width, &mut height)?;

            let out = CreateStreamOnHGlobal(HGLOBAL::default(), true)?;
            let encoder = factory.CreateEncoder(&GUID_ContainerFormatJpeg, std::ptr::null())?;
            encoder.Initialize(&out, WICBitmapEncoderNoCache)?;
            let mut frame_out = None;
            encoder.CreateNewFrame(&mut frame_out, std::ptr::null_mut())?;
            let frame_out: IWICBitmapFrameEncode = frame_out.ok_or_else(|| Error::from(E_FAIL))?;
            frame_out.Initialize(None)?;
            frame_out.SetSize(width, height)?;
            let mut format = GUID_WICPixelFormat24bppBGR;
            frame_out.SetPixelFormat(&mut format)?;
            frame_out.WriteSource(&source, std::ptr::null())?;
            frame_out.Commit()?;
            encoder.Commit()?;

            let mut size = 0u64;
            out.Seek(0, STREAM_SEEK_END, Some(&mut size))?;
            out.Seek(0, STREAM_SEEK_SET, None)?;
            let mut buf = vec![0u8; size as usize];
            let mut read = 0u32;
            out.Read(buf.as_mut_ptr().cast(), buf.len() as u32, Some(&mut read))
                .ok()?;
            buf.truncate(read as usize);
            Ok(buf)
        }
    }

    /// System.Photo.Orientation, eller 1, hvis billedet ikke har en.
    unsafe fn orientation(frame: &IWICBitmapFrameDecode) -> u16 {
        let Ok(reader) = (unsafe { frame.GetMetadataQueryReader() }) else {
            return 1;
        };
        let mut value = PROPVARIANT::default();
        if unsafe { reader.GetMetadataByName(w!("System.Photo.Orientation"), &mut value) }.is_err()
        {
            return 1;
        }
        let inner = unsafe { &value.Anonymous.Anonymous };
        let o = if inner.vt == VT_UI2 {
            unsafe { inner.Anonymous.uiVal }
        } else {
            1
        };
        let _ = unsafe { PropVariantClear(&mut value) };
        o
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    /// En BMP på 3 × 2 pixel, skrevet i hånden (WIC læser BMP på alle Windows-maskiner).
    fn bmp(width: u32, height: u32) -> Vec<u8> {
        let row = (width * 3).div_ceil(4) * 4;
        let pixels = row * height;
        let mut b = Vec::new();
        b.extend_from_slice(b"BM");
        b.extend_from_slice(&(54 + pixels).to_le_bytes());
        b.extend_from_slice(&[0, 0, 0, 0]);
        b.extend_from_slice(&54u32.to_le_bytes());
        b.extend_from_slice(&40u32.to_le_bytes());
        b.extend_from_slice(&width.to_le_bytes());
        b.extend_from_slice(&height.to_le_bytes());
        b.extend_from_slice(&1u16.to_le_bytes());
        b.extend_from_slice(&24u16.to_le_bytes());
        b.extend_from_slice(&[0; 4]);
        b.extend_from_slice(&pixels.to_le_bytes());
        b.extend_from_slice(&[0; 16]);
        b.extend(std::iter::repeat_n(0x80u8, pixels as usize));
        b
    }

    #[test]
    fn laver_jpeg() {
        let jpeg = to_jpeg(&bmp(3, 2), "tif").unwrap();
        assert_eq!(&jpeg[..2], &[0xFF, 0xD8]);
        assert_eq!(&jpeg[jpeg.len() - 2..], &[0xFF, 0xD9]);
    }

    #[test]
    fn afviser_noget_der_ikke_er_et_billede() {
        assert!(to_jpeg(b"ikke et billede", "heic").is_err());
    }

    #[test]
    fn retning() {
        assert!(transform(1).is_none());
        assert!(transform(0).is_none());
        assert_eq!(
            transform(6),
            Some(windows::Win32::Graphics::Imaging::WICBitmapTransformRotate90)
        );
    }

    /// Prøvefiler fra nettet: `GT_HEIC_DIR=<mappe> cargo test heic -- --ignored`. Skriver .jpg ved siden af.
    #[test]
    #[ignore]
    fn heic_proever() {
        let dir = std::env::var("GT_HEIC_DIR").unwrap();
        for e in std::fs::read_dir(&dir).unwrap().flatten() {
            let p = e.path();
            let ext = p
                .extension()
                .unwrap_or_default()
                .to_string_lossy()
                .to_lowercase();
            if !CONVERT_EXT.contains(&ext.as_str()) {
                continue;
            }
            let jpeg = to_jpeg(&std::fs::read(&p).unwrap(), &ext).unwrap();
            std::fs::write(p.with_extension("jpg"), &jpeg).unwrap();
            println!(
                "{}: {} → {} byte",
                p.display(),
                e.metadata().unwrap().len(),
                jpeg.len()
            );
        }
    }
}

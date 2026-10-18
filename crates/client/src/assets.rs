use anyhow::{Context,Result,ensure};
use image::{DynamicImage,GenericImageView,ImageFormat,imageops::FilterType};
use sha2::{Digest,Sha256};
use std::{fs,io::{Cursor,Read},path::Path};
use crate::database::Database;

pub struct Assets;
impl Assets {
	fn source(value:&str)->Result<(Vec<u8>,String)>{let drive_path=value.as_bytes().first().is_some_and(u8::is_ascii_alphabetic)&&value.as_bytes().get(1)==Some(&b':');if let Some(url)=(!drive_path).then(||url::Url::parse(value).ok()).flatten(){ensure!(matches!(url.scheme(),"http"|"https"),"Use an HTTP/HTTPS image URL or local path");let response=reqwest::blocking::Client::builder().timeout(std::time::Duration::from_secs(10)).redirect(reqwest::redirect::Policy::limited(3)).build()?.get(url.clone()).send()?;ensure!(response.status().is_success(),"Remote image could not be downloaded");ensure!(response.content_length().is_none_or(|size|size<=5*1048576),"Image exceeds 5 MiB");let mut bytes=Vec::new();response.take(5*1048576+1).read_to_end(&mut bytes)?;ensure!(bytes.len()<=5*1048576,"Image exceeds 5 MiB");Ok((bytes,url.to_string()))}else{let path=Path::new(value);let metadata=fs::metadata(path).with_context(||format!("Cannot read image {}",path.display()))?;ensure!(metadata.is_file()&&metadata.len()<=5*1048576,"Choose an image up to 5 MiB");Ok((fs::read(path)?,String::new()))}}
	pub fn normalize(bytes:&[u8],source_url:&str)->Result<(serde_json::Value,Vec<u8>)>{ensure!(!bytes.is_empty()&&bytes.len()<=5*1048576,"Choose an image up to 5 MiB");let format=image::guess_format(bytes)?;ensure!(matches!(format,ImageFormat::Png|ImageFormat::Jpeg|ImageFormat::WebP|ImageFormat::Gif),"Use PNG, JPG, WebP, or GIF");let decoded=image::load_from_memory_with_format(bytes,format)?;let(width,height)=decoded.dimensions();ensure!(width>0&&height>0&&width<=16384&&height<=16384,"Invalid image dimensions");let animated=format==ImageFormat::Gif;let(data,mime)=if animated{ensure!(width<=2048&&height<=2048,"Animated image dimensions exceed 2048");(bytes.to_vec(),"image/gif")}else{let image=if width>2048||height>2048{decoded.resize(2048,2048,FilterType::Lanczos3)}else{decoded};let mut output=Cursor::new(Vec::new());if image.color().has_alpha(){image.write_to(&mut output,ImageFormat::Png)?;(output.into_inner(),"image/png")}else{let mut encoder=image::codecs::jpeg::JpegEncoder::new_with_quality(&mut output,86);encoder.encode_image(&DynamicImage::ImageRgb8(image.to_rgb8()))?;(output.into_inner(),"image/jpeg")}};ensure!(data.len()<=2*1048576,"Normalized image exceeds 2 MiB");let(width,height)=image::load_from_memory(&data)?.dimensions();let id=format!("{:x}",Sha256::digest(&data));let metadata=serde_json::json!({"id":id,"mime_type":mime,"size":data.len(),"width":width,"height":height,"animated":animated,"source_urls":if source_url.is_empty(){serde_json::json!([])}else{serde_json::json!([source_url])}});Ok((metadata,data))}
	pub fn import(db:&Database,value:&str)->Result<serde_json::Value>{let(bytes,source)=Self::source(value.trim())?;let(metadata,data)=Self::normalize(&bytes,&source)?;db.put_asset(&metadata,&data,false)?;Ok(metadata)}
	pub fn accept(db:&Database,bytes:&[u8],id:&str,uploaded:bool)->Result<serde_json::Value>{ensure!(bytes.len()<=2*1048576&&format!("{:x}",Sha256::digest(bytes))==id,"Bundle asset hash mismatch");let format=image::guess_format(bytes)?;ensure!(matches!(format,ImageFormat::Png|ImageFormat::Jpeg|ImageFormat::WebP|ImageFormat::Gif),"Invalid bundle image");let image=image::load_from_memory_with_format(bytes,format)?;let(width,height)=image.dimensions();ensure!(width<=2048&&height<=2048,"Bundle image dimensions exceed limits");let mime=match format{ImageFormat::Png=>"image/png",ImageFormat::Jpeg=>"image/jpeg",ImageFormat::WebP=>"image/webp",_=>"image/gif"};let metadata=serde_json::json!({"id":id,"mime_type":mime,"size":bytes.len(),"width":width,"height":height,"animated":format==ImageFormat::Gif,"source_urls":[]});db.put_asset(&metadata,bytes,uploaded)?;Ok(metadata)}
}

#[cfg(test)]
mod tests {
	use super::*;
	use image::{Frame, RgbaImage, codecs::gif::GifEncoder};

	#[test]
	fn animated_gifs_round_trip_with_frame_dimensions_and_reject_oversized_frames() {
		for (width, height, frames) in [(100, 100, 30), (2049, 1, 2), (1, 2049, 2)] {
			let mut bytes = Vec::new();
			{
				let mut encoder = GifEncoder::new(&mut bytes);
				for index in 0..frames { encoder.encode_frame(Frame::new(RgbaImage::from_pixel(width, height, image::Rgba([index as u8, 0, 0, 255])))).unwrap(); }
			}
			let directory = tempfile::tempdir().unwrap(); let db = Database::open(directory.path()).unwrap();
			if width > 2048 || height > 2048 {
				assert!(Assets::normalize(&bytes, "").unwrap_err().to_string().contains("dimensions"));
				let id = format!("{:x}", Sha256::digest(&bytes));
				assert!(Assets::accept(&db, &bytes, &id, false).is_err());
			} else {
				let (metadata, normalized) = Assets::normalize(&bytes, "").unwrap();
				assert_eq!(metadata["width"], width); assert_eq!(metadata["height"], height); assert_eq!(normalized, bytes);
				let accepted = Assets::accept(&db, &normalized, metadata["id"].as_str().unwrap(), false).unwrap();
				assert_eq!(accepted["height"], height); assert_eq!(accepted["animated"], true);
			}
		}
	}
    #[test]
    fn image_sources_accept_local_paths_and_bound_unknown_length_downloads() {
        use std::{io::{Read,Write},net::TcpListener,time::Duration};
        let root = tempfile::tempdir().unwrap(); let path = root.path().join("image.png"); fs::write(&path,b"local bytes").unwrap();
        assert_eq!(Assets::source(path.to_str().unwrap()).unwrap().0,b"local bytes");
        for path in [r"C:\Users\Alice\Pictures\image.png", "C:/Users/Alice/Pictures/image.png", r"C:relative.png"] {
            assert!(Assets::source(path).unwrap_err().to_string().starts_with("Cannot read image"));
        }
        assert!(Assets::source("ftp://example.test/image").unwrap_err().to_string().contains("HTTP/HTTPS"));
        for oversized in [false,true] {
            let listener=TcpListener::bind("127.0.0.1:0").unwrap(); let url=format!("http://{}/image",listener.local_addr().unwrap());
            let worker=std::thread::spawn(move || {
                let (mut stream,_)=listener.accept().unwrap(); stream.set_read_timeout(Some(Duration::from_secs(3))).unwrap(); let mut byte=[0]; let mut headers=Vec::new();
                while !headers.ends_with(b"\r\n\r\n") { stream.read_exact(&mut byte).unwrap(); headers.push(byte[0]); }
                stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nConnection: close\r\n\r\n").unwrap();
                if oversized { stream.write_all(&vec![0;5*1048576+1]).unwrap(); assert_eq!(stream.read(&mut byte).unwrap(),0,"client must close without waiting for EOF"); }
                else { stream.write_all(b"small image").unwrap(); }
            });
            let result=Assets::source(&url);
            if oversized { assert!(result.unwrap_err().to_string().contains("Image exceeds 5 MiB")); } else { assert_eq!(result.unwrap().0,b"small image"); }
            worker.join().unwrap();
        }
    }

}

use tauri::image::Image;

const BADGE_SIZE: u32 = 16;

// 3x5 bitmap font for digits '0'-'9' and '+'
// Format: 5 rows of 3-bit values (bits 2, 1, 0 from left to right)
const GLYPHS: [[u8; 5]; 11] = [
    // '0'
    [0b111, 0b101, 0b101, 0b101, 0b111],
    // '1'
    [0b010, 0b110, 0b010, 0b010, 0b111],
    // '2'
    [0b111, 0b001, 0b111, 0b100, 0b111],
    // '3'
    [0b111, 0b001, 0b111, 0b001, 0b111],
    // '4'
    [0b101, 0b101, 0b111, 0b001, 0b001],
    // '5'
    [0b111, 0b100, 0b111, 0b001, 0b111],
    // '6'
    [0b111, 0b100, 0b111, 0b101, 0b111],
    // '7'
    [0b111, 0b001, 0b010, 0b010, 0b010],
    // '8'
    [0b111, 0b101, 0b111, 0b101, 0b111],
    // '9'
    [0b111, 0b101, 0b111, 0b001, 0b111],
    // '+' (index 10)
    [0b000, 0b010, 0b111, 0b010, 0b000],
];

/// Parse a hex color string like "#F52D2D" or "F52D2D" into (r, g, b).
/// Falls back to red on any parse error.
pub fn parse_hex_color(hex: &str) -> (u8, u8, u8) {
    let hex = hex.trim().trim_start_matches('#');
    if hex.len() == 6 {
        if let (Ok(r), Ok(g), Ok(b)) = (
            u8::from_str_radix(&hex[0..2], 16),
            u8::from_str_radix(&hex[2..4], 16),
            u8::from_str_radix(&hex[4..6], 16),
        ) {
            return (r, g, b);
        }
    }
    // Default red
    (245, 45, 45)
}

fn draw_glyph(rgba: &mut [u8], glyph_idx: usize, start_x: i32, start_y: i32) {
    if glyph_idx >= GLYPHS.len() {
        return;
    }
    let glyph = GLYPHS[glyph_idx];
    for (row_idx, &row) in glyph.iter().enumerate() {
        let y = start_y + row_idx as i32;
        if y < 0 || y >= BADGE_SIZE as i32 {
            continue;
        }
        for col_idx in 0..3 {
            let x = start_x + col_idx;
            if x < 0 || x >= BADGE_SIZE as i32 {
                continue;
            }
            if (row & (1 << (2 - col_idx))) != 0 {
                let pixel_idx = ((y as u32 * BADGE_SIZE + x as u32) * 4) as usize;
                rgba[pixel_idx] = 255;
                rgba[pixel_idx + 1] = 255;
                rgba[pixel_idx + 2] = 255;
                rgba[pixel_idx + 3] = 255;
            }
        }
    }
}

/// Generates a 16x16 overlay icon for the Windows taskbar.
/// - If `count > 0`: draws a colored circle with the white number (or "9+").
/// - If `has_unread`: draws a clean anti-aliased colored dot with a crisp white border.
/// - If neither: returns `None` to clear the overlay icon.
/// The `color` parameter is a hex string like "#F52D2D".
pub fn create_badge_icon(count: u32, has_unread: bool, color: &str) -> Option<Image<'static>> {
    if !has_unread && count == 0 {
        return None;
    }

    let (cr, cg, cb) = parse_hex_color(color);

    let mut rgba = vec![0u8; (BADGE_SIZE * BADGE_SIZE * 4) as usize];
    let cx = (BADGE_SIZE as f32) / 2.0;
    let cy = (BADGE_SIZE as f32) / 2.0;
    let radius = 6.8f32;
    let border_thickness = 1.0f32;

    // Draw circular badge with white outer ring
    for y in 0..BADGE_SIZE {
        for x in 0..BADGE_SIZE {
            let dx = (x as f32 + 0.5) - cx;
            let dy = (y as f32 + 0.5) - cy;
            let dist = (dx * dx + dy * dy).sqrt();

            let pixel_idx = ((y * BADGE_SIZE + x) * 4) as usize;

            if dist <= radius {
                let edge_alpha = if dist > radius - 0.75 {
                    ((radius - dist) / 0.75).clamp(0.0, 1.0)
                } else {
                    1.0
                };

                if dist >= radius - border_thickness {
                    // White border
                    rgba[pixel_idx] = 255;
                    rgba[pixel_idx + 1] = 255;
                    rgba[pixel_idx + 2] = 255;
                    rgba[pixel_idx + 3] = (255.0 * edge_alpha) as u8;
                } else {
                    // Fill color
                    rgba[pixel_idx] = cr;
                    rgba[pixel_idx + 1] = cg;
                    rgba[pixel_idx + 2] = cb;
                    rgba[pixel_idx + 3] = (255.0 * edge_alpha) as u8;
                }
            }
        }
    }

    if count > 0 {
        if count <= 9 {
            draw_glyph(&mut rgba, count as usize, 7, 5);
        } else {
            // Draw "9+"
            draw_glyph(&mut rgba, 9, 4, 5);
            draw_glyph(&mut rgba, 10, 9, 5);
        }
    }

    Some(Image::new_owned(rgba, BADGE_SIZE, BADGE_SIZE))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_zero_unread_clears_badge() {
        assert!(create_badge_icon(0, false, "#F52D2D").is_none());
    }

    #[test]
    fn test_red_dot_for_unread_without_numeric_count() {
        let badge = create_badge_icon(0, true, "#F52D2D");
        assert!(badge.is_some());
        let img = badge.unwrap();
        assert_eq!(img.width(), 16);
        assert_eq!(img.height(), 16);
        assert_eq!(img.rgba().len(), 16 * 16 * 4);

        // Center pixel should be the fill color red
        let idx = (8 * 16 + 8) * 4;
        assert_eq!(img.rgba()[idx], 245);
        assert_eq!(img.rgba()[idx + 1], 45);
        assert_eq!(img.rgba()[idx + 2], 45);
        assert_eq!(img.rgba()[idx + 3], 255);
    }

    #[test]
    fn test_custom_color_badge() {
        let badge = create_badge_icon(0, true, "#0084FF");
        assert!(badge.is_some());
        let img = badge.unwrap();
        let idx = (8 * 16 + 8) * 4;
        assert_eq!(img.rgba()[idx], 0x00);
        assert_eq!(img.rgba()[idx + 1], 0x84);
        assert_eq!(img.rgba()[idx + 2], 0xFF);
    }

    #[test]
    fn test_parse_hex_color() {
        assert_eq!(parse_hex_color("#F52D2D"), (245, 45, 45));
        assert_eq!(parse_hex_color("0084FF"), (0, 132, 255));
        assert_eq!(parse_hex_color("invalid"), (245, 45, 45)); // fallback
    }

    #[test]
    fn test_numeric_badge_single_digit() {
        for n in 1..=9 {
            let badge = create_badge_icon(n, true, "#F52D2D");
            assert!(badge.is_some());
            let img = badge.unwrap();
            assert_eq!(img.width(), 16);
            assert_eq!(img.height(), 16);
            assert_eq!(img.rgba().len(), 1024);

            let mut has_white_pixel = false;
            for chunk in img.rgba().chunks_exact(4) {
                if chunk[0] == 255 && chunk[1] == 255 && chunk[2] == 255 && chunk[3] == 255 {
                    has_white_pixel = true;
                    break;
                }
            }
            assert!(has_white_pixel, "Badge for count {n} should contain white glyph pixels");
        }
    }

    #[test]
    fn test_numeric_badge_overflow_count() {
        let badge = create_badge_icon(42, true, "#F52D2D");
        assert!(badge.is_some());
        let img = badge.unwrap();
        assert_eq!(img.width(), 16);
        assert_eq!(img.height(), 16);

        let mut white_pixel_count = 0;
        for chunk in img.rgba().chunks_exact(4) {
            if chunk[0] == 255 && chunk[1] == 255 && chunk[2] == 255 && chunk[3] == 255 {
                white_pixel_count += 1;
            }
        }
        assert!(white_pixel_count >= 10, "9+ should contain multiple white glyph pixels");
    }
}

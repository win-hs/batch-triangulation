# 批次三角定位工具

CSV 批次版的無線電追蹤三角定位工具。上傳一份 CSV，一次批次計算多個定位組的目標位置，並全部顯示在同一張地圖上。

線上版：https://win-hs.github.io/batch-triangulation/

## CSV 格式

每列一個觀測站，固定讀取 `group, lat, lon, azimuth` 四欄（表頭大小寫、空白不限）；若需計算磁北請加入 `date` 欄。其餘欄位忽略但保留於輸出。同一 `group` 的多列構成一個定位組（≥ 2 站才能定位）。

```csv
group,lat,lon,azimuth,date
A,24.05,120.45,63.4,2026-05-01
A,24.05,120.65,296.6,2026-05-01
A,24.15,120.55,180,2026-05-01
```

頁面內提供「下載範例」可直接取得示範資料。

## 功能

- 左側地圖：每組一色，畫出各站、方位線與估算目標（✕）。
- 全域設定（套用所有組）：真北／磁北（日期可用 CSV 或自訂）、平面／Geodesic、Centroid／MLE。
- 依 group 分類的圖例：可勾選控制顯示，支援「全選／全取消／取消無交會點」。
- 容錯：組內不交會的站會自動忽略、以其餘有效交點定位並標示。
- 下載結果 CSV：保留原欄位，附加 `tri_lat, tri_long, tri_status`。

## 技術

純 vanilla JS，無 build：Leaflet（地圖）、Turf.js（geodesic）、geomag.js（WMM 磁偏角），皆 CDN 載入。

import { generatedApartments } from "../src/data/apartments.generated.ts";
import { db, migrate } from "../server/db.mjs";

migrate();

const reset = process.argv.includes("--reset");
if (reset) {
  db.exec("DELETE FROM official_prices; DELETE FROM apartment_complexes;");
}

const insertComplex = db.prepare(`
  INSERT OR REPLACE INTO apartment_complexes (
    id, name, district, neighborhood, address, bjd_code, lat, lng, households, buildings,
    main_area, min_price, max_price, source
  ) VALUES (
    @id, @name, @district, @neighborhood, @address, @bjdCode, @lat, @lng, @households,
    @buildings, @mainArea, @minPrice, @maxPrice, @source
  )
`);

const insertPrice = db.prepare(`
  INSERT OR REPLACE INTO official_prices (
    id, complex_id, year, building, floor, area, price
  ) VALUES (
    @id, @complexId, @year, @building, @floor, @area, @price
  )
`);

const seed = db.transaction((items) => {
  for (const item of items) {
    insertComplex.run({
      id: item.id,
      name: item.name,
      district: item.district,
      neighborhood: item.neighborhood,
      address: item.address,
      bjdCode: item.bjdCode ?? null,
      lat: item.lat,
      lng: item.lng,
      households: item.households,
      buildings: item.buildings,
      mainArea: item.mainArea,
      minPrice: item.priceRange.min,
      maxPrice: item.priceRange.max,
      source: "AptListService3",
    });

    for (const row of item.transactions) {
      insertPrice.run({
        id: row.id,
        complexId: item.id,
        year: "2026",
        building: row.building,
        floor: row.floor,
        area: row.area,
        price: row.price,
      });
    }
  }
});

seed(generatedApartments);

const complexCount = db.prepare("SELECT COUNT(*) AS count FROM apartment_complexes").get().count;
const priceCount = db.prepare("SELECT COUNT(*) AS count FROM official_prices").get().count;
console.log(`Seeded ${complexCount} complexes and ${priceCount} price rows.`);

export type PriceRange = {
  min: number;
  max: number;
};

export type Transaction = {
  id: string;
  date: string;
  building: string;
  floor: number;
  area: number;
  price: number;
};

export type ApartmentComplex = {
  id: string;
  name: string;
  district: string;
  neighborhood: string;
  address: string;
  lat: number;
  lng: number;
  households: number;
  buildings: number;
  mainArea: string;
  priceRange: PriceRange;
  changeRate: number;
  transactions: Transaction[];
  image: string;
  bjdCode?: string;
};
